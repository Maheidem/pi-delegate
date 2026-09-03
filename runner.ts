/**
 * delegate — child process + RPC lifecycle for one foreground run.
 *
 * Owns exactly one child `pi` process per run (FR-007, POL-007): owned,
 * tracked, killable; never detached or unref'd. The task travels over RPC
 * stdin, never argv (POL-004). The full stdout capture and stderr stay on
 * disk; only a bounded handoff + diagnostics return to the caller
 * (FR-013/FR-014).
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	DelegateDisplayItem,
	DelegateError,
	DelegateErrorCode,
	DelegateRole,
	DelegateUsage,
	RunState,
	RunTerminalState,
	RunHooks,
	RunnerOutcome,
} from "./types.ts";
import { EMPTY_USAGE } from "./types.ts";
import { classifyRpcRecord, RpcJsonlParser, type RpcRecord } from "./rpc-jsonl.ts";
import { appendTranscriptRecord, updateRunMetadata, type OpenedRun } from "./run-store.ts";
import { formatDuration } from "./config.ts";

export interface RunnerConfig {
	maxResultBytes: number;
	inactivityTimeoutMs: number;
	hardTimeoutMs: number;
	killGraceMs: number;
	updateThrottleMs: number;
	maxRecordBytes?: number;
	malformedThreshold?: number;
}

export type PiInvocationResolver = (piPath?: string) => {
	command: string;
	args: string[];
};

/**
 * Robust Pi executable resolution (official example pattern, §9.4):
 * 1. current Pi script path (argv[1]) exists → node/bun + that script;
 * 2. compiled executable → execPath directly;
 * 3. otherwise `pi` on PATH.
 */
export function resolvePiInvocation(piPath?: string): { command: string; args: string[] } {
	const explicit = piPath && fs.existsSync(piPath) ? piPath : undefined;
	const argv1 = process.argv[1];
	const scriptPath = explicit ?? (argv1 && fs.existsSync(argv1) ? argv1 : undefined);
	if (scriptPath) {
		return { command: process.execPath, args: [scriptPath] };
	}
	const base = path.basename(process.execPath).toLowerCase();
	if (base.startsWith("pi") || (process.platform === "darwin" && base === "pi")) {
		return { command: process.execPath, args: [] };
	}
	return { command: "pi", args: [] };
}

export interface RunnerSpawnRequest {
	agentDir: string;
	role: DelegateRole;
	task: string;
	runId: string;
	parentModel: string;
	thinkingLevel?: string;
	cwd: string;
	projectTrusted: boolean;
	/** Registered tool names in the parent process (for role ceiling preflight). */
	registeredTools: readonly string[];
}

export function buildChildArgs(
	req: RunnerSpawnRequest,
	role: DelegateRole,
): { args: string[]; env: NodeJS.ProcessEnv; promptId: string } {
	const toolList = role.tools.join(",");
	const args: string[] = [
		"--mode", "rpc",
		"--no-session",
		"--model", req.parentModel,
	];
	if (req.thinkingLevel) args.push("--thinking", req.thinkingLevel);
	args.push("--tools", toolList);
	args.push("--no-skills", "--no-prompt-templates", "--no-themes");
	args.push("--append-system-prompt", role.promptPath);
	args.push(req.projectTrusted ? "--approve" : "--no-approve");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_DELEGATE_CHILD: "1",
		PI_DELEGATE_RUN_ID: req.runId,
		PI_DELEGATE_PARENT_PID: String(process.pid),
	};
	return { args, env, promptId: `delegate:${req.runId}:prompt` };
}

function buildPromptMessage(runId: string, role: string, task: string): string {
	return (
		`[delegated child run · id=${runId} · role=${role}]\n` +
		`This task came from a parent Pi session. Work only on this task.\n` +
		`Do not delegate or attempt to contact the parent during execution.\n` +
		`Follow the role output contract exactly.\n\n` +
		`<delegated-task>\n${task}\n</delegated-task>`
	);
}

/**
 * UTF-8-safe bounded handoff: deterministic 75% head / 25% tail split with
 * an omission marker so both the outcome and trailing risks survive
 * (NFR-004, §9.10).
 */
export function truncateHandoff(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return { text, truncated: false };
	if (maxBytes < 64) {
		// Extremely small budget: safe head-only cut.
		const head = safeHead(buf, maxBytes);
		return { text: `${head}\n… [delegate: truncated]`, truncated: true };
	}
	const headBytes = Math.floor(maxBytes * 0.75);
	const tailBytes = Math.floor(maxBytes * 0.25);
	const marker = "\n… [delegate: output truncated — middle omitted] …\n";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	const head = safeHead(buf, headBytes);
	const tail = safeTail(buf, tailBytes - markerBytes - head.length);
	return { text: `${head}${marker}${tail}`, truncated: true };
}

function safeHead(buf: Buffer, maxBytes: number): string {
	let end = Math.min(maxBytes, buf.length);
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off continuation bytes
	return buf.subarray(0, end).toString("utf8");
}

function safeTail(buf: Buffer, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	let start = Math.max(0, buf.length - maxBytes);
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // skip continuation bytes
	return buf.subarray(start).toString("utf8");
}

function displaySafeArgValue(value: unknown, limit = 80): string {
	try {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return (text ?? "").slice(0, limit);
	} catch {
		return "?";
	}
}

interface AssistantFinal {
	text: string;
	stopReason?: string;
	usage: DelegateUsage;
}

function aggregateUsage(acc: DelegateUsage, usage: unknown): void {
	if (!usage || typeof usage !== "object") return;
	const u = usage as Record<string, unknown>;
	const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	acc.input += num(u.input);
	acc.output += num(u.output);
	acc.cacheRead += num(u.cacheRead);
	acc.cacheWrite += num(u.cacheWrite);
	acc.contextTokens = num(u.totalTokens) || acc.contextTokens;
	const cost = u.cost as Record<string, unknown> | undefined;
	const total =
		typeof cost?.total === "number" ? num(cost.total) :
		num(u.cost) || 0;
	acc.cost = Math.max(acc.cost, total);
}

export class DelegateRunner {
	private child: childProcess.ChildProcess | null = null;
	private readonly opened: OpenedRun;
	private readonly req: RunnerSpawnRequest;
	private readonly cfg: RunnerConfig;
	private readonly resolveInvocation: PiInvocationResolver;
	private readonly hooks: RunHooks;

	private parser: RpcJsonlParser;
	private finalizing = false;
	private cancelRequested: RunTerminalState | null = null;
	private cancelledByUser = false;
	private promptAccepted = false;
	private settled = false;
	private lastAssistant: AssistantFinal | null = null;
	private usage: DelegateUsage = { ...EMPTY_USAGE };
	private turns = 0;
	private exitCode: number | null = null;
	private startedAt = "";
	private startedAtMs = 0;
	private inactivityTimer: NodeJS.Timeout | null = null;
	private hardTimer: NodeJS.Timeout | null = null;
	private killGraceTimer: NodeJS.Timeout | null = null;
	private settleExitTimer: NodeJS.Timeout | null = null;
	private reapEscalateTimer: NodeJS.Timeout | null = null;
	private reapKillTimer: NodeJS.Timeout | null = null;
	private childReaped = false;
	private finalError: DelegateError | null = null;
	private lastUpdateSent = 0;
	private lastActions: string[] = [];
	private diagnosticNotes: string[] = [];
	private readonly listeners: Array<{ remove: () => void }> = [];
	private transcriptSeq = 0;
	private readonly promptId: string;

	constructor(opened: OpenedRun, req: RunnerSpawnRequest, cfg: RunnerConfig, hooks: RunHooks = {}, resolveInvocation?: PiInvocationResolver) {
		this.opened = opened;
		this.req = req;
		this.cfg = cfg;
		this.hooks = hooks;
		this.resolveInvocation = resolveInvocation ?? resolvePiInvocation;
		this.promptId = `delegate:${opened.metadata.runId}:prompt`;
		this.parser = new RpcJsonlParser({
			maxRecordBytes: cfg.maxRecordBytes,
			malformedThreshold: cfg.malformedThreshold,
		});
	}

	get runId(): string {
		return this.opened.metadata.runId;
	}

	get childPid(): number | undefined {
		return this.child?.pid;
	}

	/** Spawn and drive the run to a terminal state. */
	async run(): Promise<RunnerOutcome> {
		const { metadata, paths, stdout, stderr } = this.opened;
		const role = this.req.role;

		// Preflight: research role requires a Firecrawl-capable path.
		if (role.name === "research") {
			const hasFirecrawl =
				this.req.registeredTools.some((t) =>
					t === "mcp__firecrawl" || (t.startsWith("mcp__") && /firecrawl/i.test(t)),
				) ||
				this.req.registeredTools.includes("mcp");
			if (!hasFirecrawl) {
				this.finish("failed", {
					code: "E_RESEARCH_TOOLS",
					message: "No Firecrawl-capable research tool path is available in this parent session.",
				});
				return this.outcome("failed");
			}
		}

		const invocation = this.resolveInvocation();
		const { args, env } = buildChildArgs(this.req, role);
		const launchArgs = [...invocation.args, ...args];

		let child: childProcess.ChildProcess;
		try {
			child = childProcess.spawn(invocation.command, launchArgs, {
				cwd: this.req.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				shell: false,
				detached: false,
			});
		} catch (error) {
			this.finish("failed", {
				code: "E_SPAWN",
				message: `Could not start child Pi process: ${(error as Error).message}`,
			});
			return this.outcome("failed");
		}
		this.child = child;
		this.startedAt = new Date().toISOString();
		this.startedAtMs = Date.now();
		this.updateMetadata({ state: "starting", pid: child.pid, startedAt: this.startedAt });

		// Wire streams BEFORE the prompt; stdout records are captured raw first.
		child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
		this.listeners.push({ remove: () => child.stdout?.off("data", () => {}) });

		const onStderr = (chunk: Buffer) => {
			try {
				const fd = (stderr as unknown as { fd: number | null }).fd;
				if (typeof fd === "number") fs.appendFileSync(fd, chunk);
				else stderr.write(chunk);
			} catch {
				// ignore
			}
			this.noteActivity();
		};
		child.stderr?.on("data", onStderr);

		child.on("error", (error) => {
			if (!this.finalizing) {
				this.finish("failed", {
					code: "E_SPAWN",
					message: `Child process error: ${error.message}`,
				});
			}
		});

		child.on("exit", (code, signal) => {
			this.exitCode = code ?? (signal ? 1 : 0);
			this.finalizeOnExit();
		});

		// AbortSignal from the tool call.
		if (this.hooks.abortSignal) {
			const onAbort = () => this.cancel(this.hooks.abortSignal?.reason === "abort" ? "cancelled" : "cancelled");
			if (this.hooks.abortSignal.aborted) onAbort();
			else this.hooks.abortSignal.addEventListener("abort", onAbort, { once: true });
		}

		// Timers: inactivity (reset by activity) + hard (from spawn).
		this.armInactivity();
		this.hardTimer = setTimeout(() => this.cancel("timed_out_hard"), this.cfg.hardTimeoutMs);
		this.hardTimer.unref();

		// Send the single prompt over RPC stdin.
		const promptMessage = buildPromptMessage(this.runId, role.name, this.req.task);
		const promptRecord = JSON.stringify({ id: this.promptId, type: "prompt", message: promptMessage });
		try {
			child.stdin?.write(`${promptRecord}\n`);
		} catch (error) {
			this.finish("failed", {
				code: "E_RPC_PROMPT_REJECTED",
				message: `Could not write prompt to child stdin: ${(error as Error).message}`,
			});
		}

		return await new Promise<RunnerOutcome>((resolve) => {
			this.settledResolver = resolve;
		});
	}

	private settledResolver: ((outcome: RunnerOutcome) => void) | null = null;

	private onStdout(chunk: Buffer): void {
		this.noteActivity();
		const records = this.parser.feed(chunk);
		for (const record of records) this.handleRecord(record);
	}


	private noteActivity(): void {
		this.armInactivity();
	}

	private armInactivity(): void {
		if (this.finalizing || !this.child) return;
		if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
		this.inactivityTimer = setTimeout(() => this.cancel("timed_out_idle"), this.cfg.inactivityTimeoutMs);
		this.inactivityTimer.unref();
	}

	private handleRecord(record: RpcRecord): void {
		// Persist raw record losslessly BEFORE semantic processing.
		try {
			appendTranscriptRecord(
				this.opened.stdout,
				this.transcriptSeq++,
				new Date().toISOString(),
				record.raw,
			);
		} catch {
			// capture failure is a warning, not a run failure
		}
		if (this.parser.oversized) {
			this.finish("failed", {
				code: "E_RPC_PROTOCOL",
				message: "Child emitted an RPC record above the maximum size.",
			});
			return;
		}
		if (this.parser.exceededMalformedThreshold) {
			this.finish("failed", {
				code: "E_RPC_PROTOCOL",
				message: `Child RPC stream exceeded the malformed-record threshold (${this.parser.malformedRecords} malformed records).`,
			});
			return;
		}
		if (record.malformed) {
			this.diagnosticNotes.push(`malformed RPC record captured (index ${this.parser.malformedRecords})`);
			return;
		}
		const cls = classifyRpcRecord(record);
		switch (cls.kind) {
			case "prompt_response":
				if (cls.id === this.promptId || cls.id === "") {
					if (cls.ok) {
						this.promptAccepted = true;
						this.updateMetadata({ state: "running" });
						this.pushUpdate("running");
					} else {
						this.finish("failed", {
							code: "E_RPC_PROMPT_REJECTED",
							message: "Child rejected the prompt command.",
						});
					}
				}
				break;
			case "message_end": {
				const message = (record.parsed as { message?: unknown }).message;
				this.ingestMessage(message, cls.stopReason);
				break;
			}
			case "tool_event":
				if (cls.phase === "start" && cls.toolName) {
					this.pushAction(describeToolAction(cls.toolName, cls.args));
					this.pushUpdate(`tool:${cls.toolName}`);
				}
				break;
			case "agent_settled":
				this.settled = true;
				this.finalizeSettled();
				break;
			case "agent_end":
				// NOT a completion signal: retries/compaction may follow.
				break;
			case "extension_ui_request":
				// Auto-cancel to prevent headless deadlock.
				try {
					this.child?.stdin?.write(
						`${JSON.stringify({ type: "extension_ui_response", id: cls.id, cancelled: true })}\n`,
					);
				} catch {
					// ignore
				}
				break;
			case "extension_error":
				this.diagnosticNotes.push("child extension_error observed");
				break;
			default:
				// Unknown valid events are persisted (already) and ignored.
				break;
		}
	}

	private ingestMessage(message: unknown, stopReason?: string): void {
		if (!message || typeof message !== "object") return;
		const m = message as Record<string, unknown>;
		if (m.role !== "assistant") return;
		this.turns += 1;
		if (m.usage) aggregateUsage(this.usage, m.usage);
		const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
		const text = blocks
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("\n\n");
		const reason =
			typeof m.stopReason === "string" ? m.stopReason : stopReason;
		this.lastAssistant = {
			text,
			stopReason: reason,
			usage: { ...this.usage },
		};
	}

	/**
	 * One idempotent cancel path (§9.11): mark → RPC abort → 2 s → SIGTERM →
	 * grace (5 s default via killGraceMs) → SIGKILL. Finalizes metadata once
	 * and removes all listeners/timers.
	 */
	cancel(state: RunTerminalState): void {
		if (this.finalizing) return;
		// §9.7 — the FIRST cancellation wins; later cancels are no-ops.
		if (this.cancelRequested) return;
		const byUser = state === "cancelled";
		if (byUser) this.cancelledByUser = true;
		this.cancelRequested = state;
		const child = this.child;
		if (!child) {
			this.finish(state);
			return;
		}
		if (child.stdin?.writable) {
			try {
				child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
			} catch {
				// fall through to signals
			}
		}
		setTimeout(() => {
			if (this.finalizing || !this.child?.kill) return;
			try {
				this.child.kill("SIGTERM");
			} catch {
				// ignore
			}
			this.killGraceTimer = setTimeout(() => {
				if (this.finalizing || !this.child?.kill) return;
				try {
					this.child.kill("SIGKILL");
				} catch {
					// ignore
				}
			}, this.cfg.killGraceMs);
		}, 2000);
		// If the child never exits, the kill path above plus the exit handler
		// covers it; the hard timer is already armed as a last backstop.
	}

	private finalizeSettled(): void {
		if (this.finalizing) return;
		// A cancellation is already finalizing via the exit path (§9.7) — an
		// aborted turn legitimately has no final text and must not overwrite
		// the cancellation with E_NO_HANDOFF.
		if (this.cancelRequested) return;
		const child = this.child;
		const final = this.lastAssistant;
		if (final?.stopReason === "aborted") {
			this.finish("cancelled");
			return;
		}
		if (final?.stopReason === "error") {
			this.finish("failed", {
				code: "E_CHILD_MODEL",
				message: `Child model stopped with an error (stderr tail: ${this.stderrTail()})`,
			});
			return;
		}
		if (!final || !final.text.trim()) {
			this.finish("failed", {
				code: "E_NO_HANDOFF",
				message: "Child settled without a final assistant text message.",
			});
			return;
		}
		const { text: handoff, truncated } = truncateHandoff(final.text, this.cfg.maxResultBytes);
		this.finish("succeeded", undefined, { handoff, truncated, stopReason: final.stopReason, usage: { ...final.usage, turns: this.turns } });
		// End stdin and wait briefly for clean exit; if the RPC host remains
		// alive, SIGTERM then SIGKILL. This never turns success into failure.
		if (child) {
			try {
				child.stdin?.end();
			} catch {
				// ignore
			}
			this.settleExitTimer = setTimeout(() => {
				if (this.finalizing || !this.child?.kill) return;
				try {
					this.child.kill("SIGTERM");
				} catch {
					// ignore
				}
				this.killGraceTimer = setTimeout(() => {
					if (this.finalizing || !this.child?.kill) return;
					try {
						this.child.kill("SIGKILL");
					} catch {
						// ignore
					}
				}, this.cfg.killGraceMs);
			}, 1500);
		}
	}

	private finalizeOnExit(): void {
		// Flush any incomplete final record into the capture.
		try {
			for (const record of this.parser.close()) {
				appendTranscriptRecord(this.opened.stdout, this.transcriptSeq++, new Date().toISOString(), record.raw);
			}
		} catch {
			// ignore
		}
		if (this.finalizing) {
			this.cleanup();
			return;
		}
		if (this.cancelRequested) {
			this.finish(this.cancelRequested);
			return;
		}
		if (!this.settled && !this.promptAccepted) {
			this.finish("crashed", {
				code: "E_CHILD_EXIT",
				message: `Child exited before accepting the prompt (exit ${this.exitCode}). ${this.stderrTail()}`,
			});
			return;
		}
		if (!this.settled) {
			this.finish("crashed", {
				code: "E_CHILD_EXIT",
				message: `Child exited before settling (exit ${this.exitCode}). ${this.stderrTail()}`,
			});
		}
	}

	private stderrTail(limit = 400): string {
		try {
			const buf = fs.readFileSync(this.opened.paths.stderrPath);
			return buf.length === 0 ? "" : buf.subarray(-limit).toString("utf8").trim().slice(-300);
		} catch {
			return "";
		}
	}

	private finish(state: RunTerminalState, error?: DelegateError, extra?: { handoff?: string; truncated?: boolean; stopReason?: string; usage?: DelegateUsage }): void {
		if (this.finalizing) return;
		this.finalizing = true;
		const finishedAt = new Date().toISOString();
		const durationMs = this.startedAtMs ? Date.now() - this.startedAtMs : 0;
		// P3: timeout/cancel terminal states are reached without an explicit
		// error (timers and user cancels funnel through finish() bare).
		// Synthesize a specific payload so the tool text never degrades to
		// "unknown failure" — the header shows the state; the error line must
		// agree. Flows into both the metadata and the reported outcome.
		const effectiveError = error ?? this.synthesizedTerminalError(state);
		this.finalError = effectiveError ?? this.finalError;
		const usage = { ...(extra?.usage ?? this.usage), turns: this.turns };
		const metadataPatch: Record<string, unknown> = {
			state,
			finishedAt,
			exitCode: this.exitCode ?? undefined,
			usage,
			outputTruncated: extra?.truncated ?? false,
		};
		if (extra?.handoff !== undefined) {
			metadataPatch.finalHandoff = extra.handoff;
			metadataPatch.outputBytes = Buffer.byteLength(extra.handoff, "utf8");
		}
		if (extra?.stopReason) metadataPatch.stopReason = extra.stopReason;
		if (effectiveError) {
			metadataPatch.errorCode = effectiveError.code;
			metadataPatch.errorMessage = effectiveError.message;
		}
		if (this.diagnosticNotes.length > 0) {
			metadataPatch.errorMessage = metadataPatch.errorMessage
				? `${metadataPatch.errorMessage} [${this.diagnosticNotes.slice(-3).join("; ")}]`
				: `[${this.diagnosticNotes.slice(-3).join("; ")}]`;
		}
		try {
			updateRunMetadata(this.req.agentDir, this.runId, () => metadataPatch);
		} catch {
			// metadata write failure is diagnostic-only at finalization
		}
		try {
			this.opened.stdout.end();
			this.opened.stderr.end();
		} catch {
			// ignore
		}
		// §9 — every finalization MUST reap the child exactly once. Protocol
		// failures finalize without an exit event; without this the child
		// would orphan and keep parent pipes open.
		this.reapChild();
		this.cleanup();

		const outcome = this.outcome(state, extra, effectiveError);
		const resolver = this.settledResolver;
		this.settledResolver = null;
		resolver?.(outcome);
	}

	/**
	 * P3: specific error payloads for the terminal states reached without an
	 * explicit error. `succeeded`/`failed` already carry their error at the
	 * call site (or legitimately have none) and are unaffected.
	 */
	private synthesizedTerminalError(state: RunTerminalState): DelegateError | undefined {
		switch (state) {
			case "timed_out_idle":
				return {
					code: "E_TIMEOUT_IDLE",
					message: `no child activity for ${formatDuration(this.cfg.inactivityTimeoutMs)} (inactivity watchdog)`,
				};
			case "timed_out_hard":
				return {
					code: "E_TIMEOUT_HARD",
					message: `hard timeout of ${formatDuration(this.cfg.hardTimeoutMs)} reached (wall-clock cap)`,
				};
			case "cancelled":
				return {
					code: "E_CANCELLED",
					message: this.cancelledByUser ? "cancelled by user" : "aborted (parent session abort)",
				};
			default:
				return undefined;
		}
	}

	private outcome(
		state: RunTerminalState,
		extra?: { handoff?: string; truncated?: boolean; stopReason?: string; usage?: DelegateUsage },
		error?: DelegateError,
	): RunnerOutcome {
		const finishedAt = new Date().toISOString();
		const err = error ?? this.finalError ?? undefined;
		return {
			runId: this.runId,
			state,
			handoff: state === "succeeded" ? extra?.handoff ?? "" : "",
			outputBytes: Buffer.byteLength(extra?.handoff ?? "", "utf8"),
			outputTruncated: extra?.truncated ?? false,
			startedAt: this.startedAt,
			finishedAt,
			durationMs: this.startedAtMs ? Date.now() - this.startedAtMs : 0,
			exitCode: this.exitCode ?? undefined,
			stopReason: extra?.stopReason,
			usage: { ...(extra?.usage ?? this.usage), turns: this.turns },
			displayItems: this.lastActions.slice(-5).map((a) => ({
				type: "text" as const,
				text: a,
			})),
			error: err,
			transcriptPath: this.opened.paths.transcriptPath,
			stderrPath: this.opened.paths.stderrPath,
			lastActions: this.lastActions.slice(-5),
		};
	}

	private updateMetadata(patch: Record<string, unknown>): void {
		try {
			updateRunMetadata(this.req.agentDir, this.runId, () => patch);
		} catch {
			// transition metadata failure is diagnostic-only
		}
	}

	private pushAction(action: string): void {
		this.lastActions.push(action);
		if (this.lastActions.length > 10) this.lastActions.shift();
	}

	private pushUpdate(phase: "starting" | "running" | `tool:${string}` | "finalizing"): void {
		if (!this.hooks.onUpdate) return;
		const now = Date.now();
		if (now - this.lastUpdateSent < this.cfg.updateThrottleMs) return;
		this.lastUpdateSent = now;
		this.hooks.onUpdate({
			runId: this.runId,
			role: this.req.role.name,
			phase,
			elapsedMs: this.startedAtMs ? now - this.startedAtMs : 0,
			lastActions: this.lastActions.slice(-5),
			usage: { ...this.usage, turns: this.turns },
		});
	}

	/**
	 * Guaranteed one-shot reaping: RPC abort, then SIGTERM, then SIGKILL
	 * after the grace window. Never orphans the child; failures are
	 * swallowed (reaping must never change the run outcome).
	 */
	private reapChild(): void {
		const child = this.child;
		if (!child || this.childReaped || child.exitCode !== null || child.signalCode) return;
		this.childReaped = true;
		try {
			if (child.stdin?.writable) child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
			child.stdin?.end();
		} catch {
			// ignore
		}
		this.reapEscalateTimer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {
				// ignore
			}
			this.reapKillTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// ignore
				}
			}, this.cfg.killGraceMs);
		}, 250);
	}

	private cleanup(): void {
		// NOTE: reap timers intentionally survive cleanup — they must run to
		// completion to guarantee the child is killed (short-lived refs).
		if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
		if (this.hardTimer) clearTimeout(this.hardTimer);
		if (this.killGraceTimer) clearTimeout(this.killGraceTimer);
		if (this.settleExitTimer) clearTimeout(this.settleExitTimer);
		this.inactivityTimer = null;
		this.hardTimer = null;
		this.killGraceTimer = null;
		this.settleExitTimer = null;
		for (const { remove } of this.listeners) {
			try {
				remove();
			} catch {
				// ignore
			}
		}
		this.listeners.length = 0;
		const child = this.child;
		if (child) {
			try {
				child.stdout?.removeAllListeners();
				child.stderr?.removeAllListeners();
				child.removeAllListeners();
			} catch {
				// ignore
			}
		}
	}
}


/**
 * Display-safe one-liner for a child tool call (never fed to the model).
 * Keeps at most ~100 visible chars; args are user-visible command/path
 * values from the child's own session.
 */
export function describeToolAction(toolName: string, args?: Record<string, unknown>): string {
	const a = (key: string): string => {
		const v = args?.[key];
		return typeof v === "string" ? v : "";
	};
	let detail = "";
	switch (toolName) {
		case "bash":
			detail = a("command");
			break;
		case "read":
		case "write":
		case "edit":
			detail = a("path");
			break;
		case "grep":
		case "find":
			detail = [a("pattern"), a("path")].filter(Boolean).join(" ");
			break;
		case "ls":
			detail = a("path") || a("command");
			break;
		default:
			detail = "";
	}
	const text = detail ? `${toolName} ${detail}` : toolName;
	return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}
