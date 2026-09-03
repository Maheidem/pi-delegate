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
import { renderHandoff, validateHandoffSubmission, type HandoffSubmission } from "./handoff.ts";
import type { FeedEvent } from "./transcript-feed.ts";

export interface RunnerConfig {
	maxResultBytes: number;
	inactivityTimeoutMs: number;
	hardTimeoutMs: number;
	killGraceMs: number;
	/** R2: grace for the killed child's final handoff answer (default 90 s). */
	handoffGraceMs?: number;
	/** Bounded wait for a child to answer the mandatory-handoff enforcement
	 * prompt (default 60 s) — independent of the hard timeout, so a child
	 * that goes silent after settling can never dangle the run for hours. */
	handoffEnforceTimeoutMs?: number;
	/** R1: watchdog budget while a tool call is in flight (default: hard). */
	stuckToolTimeoutMs?: number;
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
	/** R3: prior run whose child session this run resumes ("--session <file>"). */
	resumeOf?: string;
	/** R3: child session file to re-enter (resume mode); new runs use --session-dir. */
	sessionPath?: string;
	/** R3: directory the child's session file is persisted to (new runs). */
	sessionDir?: string;
}

export function buildChildArgs(
	req: RunnerSpawnRequest,
	role: DelegateRole,
): { args: string[]; env: NodeJS.ProcessEnv; promptId: string } {
	// The mandatory structured-handoff tool is always in the child's
	// ceiling; the delegate extension registers it in child mode.
	const toolList = [...role.tools, "handoff"].join(",");
	// R3: the child's session is DURABLE. New runs persist it under the run
	// store (--session-dir); resumed runs re-enter the prior session file
	// directly (--session <file>) so a killed run can be continued in the
	// same context instead of a cold re-explained child.
	const sessionArgs = req.sessionPath
		? ["--session", req.sessionPath]
		: ["--session-dir", req.sessionDir ?? ".pi-sessions"];
	const args: string[] = [
		"--mode", "rpc",
		...sessionArgs,
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

function buildPromptMessage(runId: string, role: string, task: string, resumeOf?: string): string {
	const resumeNote = resumeOf
		? `You are RESUMING the child session of run ${resumeOf} (its earlier turns are in your context). Continue from where that run left off.\n`
		: "";
	return (
		`[delegated child run · id=${runId} · role=${role}]\n` +
		resumeNote +
		`This task came from a parent Pi session. Work only on this task.\n` +
		`Do not delegate or attempt to contact the parent during execution.\n` +
		`Follow the role output contract exactly.\n\n` +
		`<delegated-task>\n${task}\n</delegated-task>`
	);
}

/** R2: the bounded termination-notice prompt a timed-out child must answer
 * through the handoff TOOL (deterministic capture), with a free-text
 * fallback only if the tool path is unavailable in an older child. */
export function buildHandoffPrompt(runId: string): string {
	return (
		`[delegate ${runId} · termination notice]\n` +
		`You are being terminated NOW. Call the handoff tool IMMEDIATELY with outcome "partial":\n` +
		`- summary: what you completed so far\n` +
		`- changes: every file you created/modified so far\n` +
		`- verification: last test/typecheck state (or not_run)\n` +
		`- remaining: precise next steps for a successor\n` +
		`Do not start new work. If the handoff tool is unavailable, reply in plain text with those four sections.`
	);
}

/** R4: provider-error artifacts produced by our own abort, not the provider. */
export function isAbortArtifactErrorMessage(message: string): boolean {
	return /this operation was aborted|request was aborted|operation aborted/i.test(message);
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
	/** R4: provider errorMessage captured from the final message_end, verbatim. */
	errorMessage?: string;
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
	/** R1: toolCallIds with a start but no matching end yet. */
	private openToolCalls = new Set<string>();
	/** Feed: toolCallId → start ms (for end-event durations). */
	private toolStartedAt = new Map<string, number>();
	/** Feed: toolCallId → tool name. */
	private toolNames = new Map<string, string>();
	/** Feed: toolCallId → the start event's arg detail (path/command). */
	private toolDetails = new Map<string, string>();
	/** R2: handoff negotiation phase after a timeout cancel. */
	private handoffPhase: "none" | "await-settle" | "await-handoff" = "none";
	/** Structured handoff captured from the child's `handoff` tool call. */
	private structuredHandoff: HandoffSubmission | null = null;
	/** Bounded enforcement prompts when the child settled without submitting. */
	private handoffEnforceAttempts = 0;
	private static readonly HANDOFF_ENFORCE_MAX = 2;
	private handoffEnforceTimer: NodeJS.Timeout | null = null;
	private handoffGraceTimer: NodeJS.Timeout | null = null;
	private handoffSettleTimer: NodeJS.Timeout | null = null;
	private killEscalateTimer: NodeJS.Timeout | null = null;
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

		// R6: worktree checkpoint at run start (BEFORE spawn — no sync work
		// may sit between spawn and stream wiring; a fast-exiting child
		// would otherwise win the race to close stdin). Post-death
		// inspection becomes `git diff <gitBase>` instead of re-reading.
		const gitBase = gitCheckpoint(this.req.cwd);

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
		this.updateMetadata({
			state: "starting",
			pid: child.pid,
			startedAt: this.startedAt,
			...(this.req.resumeOf ? { resumeOf: this.req.resumeOf } : {}),
			...(this.req.sessionPath ? { sessionPath: this.req.sessionPath } : {}),
			...(gitBase ? gitBase : {}),
		});

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

		// A fast-exiting child closes stdin before/as the prompt is written;
		// the resulting EPIPE must never escape as an unhandled stream error
		// (the exit handler already finalizes the run).
		child.stdin?.on("error", () => {});

		// Send the single prompt over RPC stdin.
		const promptMessage = buildPromptMessage(this.runId, role.name, this.req.task, this.req.resumeOf);
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
		this.lastStreamActivityMs = Date.now();
		const records = this.parser.feed(chunk);
		for (const record of records) this.handleRecord(record);
	}

	/** R2: last stdout timestamp — the settle wait re-arms while the child
	 * is still streaming its post-abort message instead of killing it. */
	private lastStreamActivityMs = 0;
	private cancelRequestedAtMs: number | null = null;


	private noteActivity(): void {
		this.armInactivity();
	}

	/** R1: in-flight tool calls count as activity — the watchdog switches to
	 * the (much longer) stuck-tool budget while a tool call is open, so a
	 * legitimate long-running tool (test matrix, benchmark, soak) is never
	 * idle-killed mid-execution. A genuinely hung child with NO open tool
	 * still hits the normal inactivity budget. */
	private armInactivity(): void {
		if (this.finalizing || !this.child) return;
		if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
		const budget = this.openToolCalls.size > 0
			? this.cfg.stuckToolTimeoutMs ?? this.cfg.hardTimeoutMs
			: this.cfg.inactivityTimeoutMs;
		this.inactivityTimer = setTimeout(() => this.cancel("timed_out_idle"), budget);
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
				const m = message as { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type?: string; text?: string }> } | null;
				if (m?.role === "assistant") {
					if (m.stopReason === "error") {
						this.emitEvent({
							atMs: Date.now(),
							kind: "provider_error",
							detail: (m.errorMessage ?? "").trim() || "provider error (no message)",
						});
					} else {
						const text = (m.content ?? []).find((b) => b?.type === "text" && b.text?.trim())?.text ?? "";
						if (text.trim()) {
							this.emitEvent({
								atMs: Date.now(),
								kind: "assistant",
								detail: text.split("\n").filter(Boolean)[0] ?? "",
							});
						}
					}
				}
				break;
			}
			case "tool_event":
				// R1: track open tool calls (start/end pairs by toolCallId).
				if (cls.id) {
					if (cls.phase === "start") {
						this.openToolCalls.add(cls.id);
						this.toolStartedAt.set(cls.id, Date.now());
						if (cls.toolName) this.toolNames.set(cls.id, cls.toolName);
						this.toolDetails.set(cls.id, feedDetailFor(cls.toolName ?? "", cls.args));
					} else if (cls.phase === "end") {
						this.openToolCalls.delete(cls.id);
						this.toolStartedAt.delete(cls.id);
						this.toolNames.delete(cls.id);
						this.toolDetails.delete(cls.id);
					}
					// a tool event resets the watchdog to the right budget
					this.armInactivity();
				}
				if (cls.phase === "start" && cls.toolName) {
					this.pushAction(describeToolAction(cls.toolName, cls.args));
					this.pushUpdate(`tool:${cls.toolName}`);
					this.emitEvent({
						atMs: Date.now(),
						kind: "tool_start",
						tool: cls.toolName,
						detail: feedDetailFor(cls.toolName, cls.args),
					});
				}
				if (cls.phase === "end" && cls.toolName && cls.id) {
					const started = this.toolStartedAt.get(cls.id);
					// Echo the start's arg detail (path/command); bash keeps
					// its output head — file-content heads are noise.
					const argDetail = this.toolDetails.get(cls.id) ?? "";
					const head = cls.result?.textHead ?? "";
					const detail =
						cls.toolName === "bash" && head ? head.slice(0, 70) : (argDetail || head.slice(0, 70) || "done");
					this.emitEvent({
						atMs: Date.now(),
						kind: "tool_end",
						tool: cls.toolName,
						detail,
						isError: cls.result?.isError === true,
						...(started ? { durationMs: Date.now() - started } : {}),
					});
				}
				// Structured handoff: the child's mandatory final report rides
				// on the handoff tool result details — capture it verbatim
				// (re-validated; a stale/malformed payload is ignored).
				if (cls.phase === "end" && cls.toolName === "handoff") {
					const candidate = (cls.result?.details as { delegateHandoff?: unknown } | undefined)?.delegateHandoff;
					const validation = validateHandoffSubmission(candidate);
					if (validation.ok) {
						this.structuredHandoff = validation.value ?? null;
						this.emitEvent({
							atMs: Date.now(),
							kind: "handoff",
							detail: `handoff submitted (${validation.value?.outcome ?? "?"})`,
						});
					}
				}
				break;
			case "agent_settled":
				this.settled = true;
				this.emitEvent({ atMs: Date.now(), kind: "settled", detail: "agent settled" });
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
		// R4: the provider's own error text rides on message_end.errorMessage —
		// capture it verbatim (e.g. "Codex error: The usage limit has been
		// reached", or abort artifacts like "This operation was aborted").
		const errorMessage = typeof m.errorMessage === "string" ? m.errorMessage : undefined;
		this.lastAssistant = {
			text,
			stopReason: reason,
			...(errorMessage ? { errorMessage } : {}),
			usage: { ...this.usage },
		};
	}

	/**
	 * R2 — timeout cancellation with a graceful handoff attempt:
	 *  1. RPC `abort` (ends the in-flight tool/turn, exactly as before);
	 *  2. wait (bounded, 5 s) for the child to settle;
	 *  3. send the termination-notice prompt; wait `handoffGraceMs`;
	 *  4. capture the child's final answer as `partialHandoff`;
	 *  5. SIGTERM → killGrace → SIGKILL (the old path, as fallback).
	 * A user/parent `cancelled` keeps the OLD fast path (2 s → SIGTERM):
	 * the caller asked to stop, not to negotiate.
	 */
	cancel(state: RunTerminalState): void {
		if (this.finalizing) return;
		// §9.7 — the FIRST cancellation wins; later cancels are no-ops.
		if (this.cancelRequested) return;
		const byUser = state === "cancelled";
		if (byUser) this.cancelledByUser = true;
		this.cancelRequested = state;
		this.cancelRequestedAtMs = Date.now();
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
		if (byUser) {
			// Fast path (unchanged): 2 s → SIGTERM → grace → SIGKILL.
			this.startKillEscalation(2000);
			return;
		}
		// Timeout path: negotiate a partial handoff, bounded at every step.
		this.handoffPhase = "await-settle";
		this.armHandoffSettleWait(this.startedAtMs ? Date.now() : Date.now());
	}

	/**
	 * R2: wait (bounded) for the child to settle after the abort. A real
	 * child often keeps streaming its interrupted turn for several seconds
	 * after the abort (observed: ≥5 s of message_update deltas) — while it
	 * is still producing output we re-arm instead of killing mid-sentence.
	 */
	private armHandoffSettleWait(_startedAt: number): void {
		const stepMs = 5000;
		const capMs = 45_000;
		this.handoffSettleTimer = setTimeout(() => {
			if (this.finalizing || this.handoffPhase !== "await-settle") return;
			const quiet = Date.now() - this.lastStreamActivityMs;
			if (quiet < 3000 && Date.now() - (this.cancelRequestedAtMs ?? Date.now()) < capMs) {
				this.armHandoffSettleWait(_startedAt);
				return;
			}
			// Child never settled after the abort — no negotiation possible.
			this.handoffPhase = "none";
			this.startKillEscalation(0);
		}, stepMs);
		this.handoffSettleTimer.unref();
	}

	/** SIGTERM → killGrace → SIGKILL escalation (one shared implementation). */
	private startKillEscalation(delayMs: number): void {
		if (this.finalizing) return;
		this.killEscalateTimer = setTimeout(() => {
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
		}, delayMs);
		this.killEscalateTimer.unref();
	}

	/** R2: the child settled after our abort — offer it the handoff prompt. */
	private beginHandoffPrompt(): void {
		this.handoffPhase = "await-handoff";
		try {
			this.child?.stdin?.write(
				`${JSON.stringify({ id: `${this.runId}:handoff`, type: "prompt", message: buildHandoffPrompt(this.runId) })}\n`,
			);
		} catch {
			// child gone — fall back to the kill path
			this.handoffPhase = "none";
			this.startKillEscalation(0);
			return;
		}
		const grace = this.cfg.handoffGraceMs ?? 90_000;
		this.handoffGraceTimer = setTimeout(() => {
			// Grace exhausted — finalize with whatever we already captured.
			this.handoffPhase = "none";
			if (!this.finalizing) {
				this.startKillEscalation(0);
				if (this.cancelRequested) this.finish(this.cancelRequested, undefined, this.partialHandoffExtra());
			}
		}, grace);
		this.handoffGraceTimer.unref();
	}

	/** R2: build the partial-handoff `extra`. The structured submission
	 * (from the handoff tool) wins; free text is the fallback. */
	private partialHandoffExtra(): { handoff?: string; truncated?: boolean; partialHandoff?: string } | undefined {
		if (this.structuredHandoff) {
			return { partialHandoff: renderHandoff(this.structuredHandoff, { partial: true }) };
		}
		const text = this.lastAssistant?.text?.trim();
		if (!text) return undefined;
		const { text: bounded, truncated } = truncateHandoff(text, this.cfg.maxResultBytes);
		return { partialHandoff: bounded, truncated };
	}

	private finalizeSettled(): void {
		if (this.finalizing) return;
		// R2: a timeout cancellation negotiates a partial handoff BEFORE it
		// finalizes. Settles arriving during the negotiation belong to the
		// handoff exchange, not to the run outcome.
		if (this.cancelRequested && this.handoffPhase === "await-settle") {
			this.beginHandoffPrompt();
			return;
		}
		if (this.cancelRequested && this.handoffPhase === "await-handoff") {
			// The child answered the termination-notice prompt — finalize with
			// whatever it wrote as the partial handoff.
			this.handoffPhase = "none";
			this.finish(this.cancelRequested, undefined, this.partialHandoffExtra());
			return;
		}
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
			// R4 — precise provider-error diagnosis. The provider's own text
			// rides on message_end.errorMessage; quote it verbatim. Abort
			// artifacts (our own watchdog abort surfacing as stop=error) are
			// classified as killed-by-watchdog, not blamed on the provider.
			// The stderr tail is NEVER presented as the cause — it is routinely
			// unrelated noise (e.g. model-discovery notices about user config).
			const providerMessage = final.errorMessage?.trim();
			if (providerMessage && !isAbortArtifactErrorMessage(providerMessage)) {
				this.finish("failed", {
					code: "E_PROVIDER_ERROR",
					message: `Provider error: ${providerMessage}`,
				});
				return;
			}
			if (providerMessage) {
				this.finish("failed", {
					code: "E_CHILD_MODEL",
					message: `Child aborted mid-request (${providerMessage}); typically a watchdog/timeout kill landing mid-generation, not a provider fault.`,
				});
				return;
			}
			this.finish("failed", {
				code: "E_CHILD_MODEL",
				message: `Child model stopped with an error (no provider message on the final message; unrelated stderr tail: ${this.stderrTail()})`,
			});
			return;
		}
		// Protocol enforcement: the child MUST submit the structured handoff
		// via the handoff tool. A settle without it is re-prompted (bounded);
		// after the budget is spent the free-text ending is accepted with a
		// diagnostic note (older children without the tool still finish).
		if (
			!this.structuredHandoff &&
			this.handoffEnforceAttempts < DelegateRunner.HANDOFF_ENFORCE_MAX &&
			final?.text.trim()
		) {
			this.handoffEnforceAttempts += 1;
			let written = false;
			try {
				this.child?.stdin?.write(
					`${JSON.stringify({
						id: `${this.runId}:handoff-required`,
						type: "prompt",
						message:
							`[delegate ${this.runId} · handoff required]\n` +
							`Your run ended WITHOUT the mandatory handoff tool call. Call the handoff tool NOW with your structured result ` +
							`(outcome, summary, changes, verification, remaining, risks). Do not write free text; the run does not complete without it.`,
					})}\n`,
				);
				written = true;
			} catch {
				// child gone — finalize on what we have
			}
			if (written) {
				// DEADLOCK GUARD: the child already finished its work; if it
				// never answers the enforcement prompt (older child, hung
				// model), finalize with the free-text fallback after a SHORT
				// bound — never the remaining hard budget.
				if (this.handoffEnforceTimer) clearTimeout(this.handoffEnforceTimer);
				this.handoffEnforceTimer = setTimeout(() => {
					if (this.finalizing) return;
					this.handoffPhase = "none";
					this.finalizeFreeTextFallback();
				}, this.cfg.handoffEnforceTimeoutMs ?? 60_000);
				this.handoffEnforceTimer.unref();
				return; // wait for the enforcement turn to settle
			}
		}
		if (!final || !final.text.trim()) {
			if (this.structuredHandoff) {
				// Tool submitted but the child never wrote a closing message:
				// the structured submission IS the handoff.
				this.finish("succeeded", undefined, {
					handoff: renderHandoff(this.structuredHandoff),
					truncated: false,
					stopReason: final?.stopReason,
					usage: { ...this.usage, turns: this.turns },
				});
				return;
			}
			this.finish("failed", {
				code: "E_NO_HANDOFF",
				message: "Child settled without a final assistant text message.",
			});
			return;
		}
		if (this.structuredHandoff) {
			this.finish("succeeded", undefined, {
				handoff: renderHandoff(this.structuredHandoff),
				truncated: false,
				stopReason: final.stopReason,
				usage: { ...final.usage, turns: this.turns },
			});
		} else {
			this.finalizeFreeTextFallback();
		}
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

	/**
	 * Free-text fallback finalization: the child's own closing message
	 * becomes the handoff (bounded), with a diagnostic note that the
	 * structured protocol was not satisfied.
	 */
	private finalizeFreeTextFallback(): void {
		if (this.finalizing) return;
		const final = this.lastAssistant;
		if (!final || !final.text.trim()) {
			this.finish("failed", {
				code: "E_NO_HANDOFF",
				message: "Child settled without a final assistant text message.",
			});
			return;
		}
		if (this.handoffEnforceAttempts > 0) {
			this.diagnosticNotes.push("child settled without the handoff tool; free-text handoff accepted after enforcement retries");
		}
		const { text: handoff, truncated } = truncateHandoff(final.text, this.cfg.maxResultBytes);
		this.finish("succeeded", undefined, { handoff, truncated, stopReason: final.stopReason, usage: { ...final.usage, turns: this.turns } });
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

	private finish(state: RunTerminalState, error?: DelegateError, extra?: { handoff?: string; truncated?: boolean; stopReason?: string; usage?: DelegateUsage; partialHandoff?: string }): void {
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
		// Structured handoff (from the child's handoff tool call).
		if (this.structuredHandoff) metadataPatch.handoffData = this.structuredHandoff;
		// R2: partial handoff from a killed child — first-class receipt field.
		if (extra?.partialHandoff !== undefined) {
			metadataPatch.partialHandoff = extra.partialHandoff;
		}
		// R3: locate + record the child's durable session file (new runs).
		if (!this.req.sessionPath) {
			const sessionPath = this.locateChildSession();
			if (sessionPath) metadataPatch.sessionPath = sessionPath;
		}
		// R6: post-run worktree delta (bounded).
		const gitDelta = gitDeltaSince(this.req.cwd);
		if (gitDelta) metadataPatch.gitDelta = gitDelta;
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
				return this.openToolCalls.size > 0
					? {
						code: "E_TIMEOUT_IDLE",
						message: `in-flight tool call exceeded the stuck-tool budget of ${formatDuration(this.cfg.stuckToolTimeoutMs ?? this.cfg.hardTimeoutMs)} (${this.openToolCalls.size} tool call(s) still open)`,
					}
					: {
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
		extra?: { handoff?: string; truncated?: boolean; stopReason?: string; usage?: DelegateUsage; partialHandoff?: string },
		error?: DelegateError,
	): RunnerOutcome {
		const finishedAt = new Date().toISOString();
		const err = error ?? this.finalError ?? undefined;
		return {
			runId: this.runId,
			state,
			handoff: state === "succeeded" ? extra?.handoff ?? "" : "",
			partialHandoff: state !== "succeeded" ? extra?.partialHandoff : undefined,
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

	/** Names of tools currently in flight (for live views). */
	private openToolNames(): string[] {
		const names = new Set<string>();
		for (const id of this.openToolCalls) {
			const name = this.toolNames.get(id);
			if (name) names.add(name);
		}
		return [...names];
	}

	/** Live feed fan-out (unthrottled; views bound what they keep). */
	private emitEvent(event: FeedEvent): void {
		try {
			this.hooks.onEvent?.(event);
		} catch {
			// feed failures never affect the run
		}
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
			model: this.req.parentModel,
			openTools: this.openToolNames(),
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

	/**
	 * R3: find the child's durable session file. New runs spawn with
	 * `--session-dir <runsDir>/sessions`; pi names the file itself, so we
	 * take the newest session file in that directory written during this
	 * run's lifetime. Best-effort: absent when pi did not persist one.
	 */
	private locateChildSession(): string | undefined {
		const dir = this.req.sessionDir;
		if (!dir || !this.startedAtMs) return undefined;
		try {
			const names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
			let best: { name: string; mtime: number } | null = null;
			for (const name of names) {
				const st = fs.statSync(path.join(dir, name));
				if (st.mtimeMs >= this.startedAtMs - 2_000 && (!best || st.mtimeMs > best.mtime)) {
					best = { name, mtime: st.mtimeMs };
				}
			}
			return best ? path.join(dir, best.name) : undefined;
		} catch {
			return undefined;
		}
	}

	private cleanup(): void {
		// NOTE: reap timers intentionally survive cleanup — they must run to
		// completion to guarantee the child is killed (short-lived refs).
		if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
		if (this.hardTimer) clearTimeout(this.hardTimer);
		if (this.killGraceTimer) clearTimeout(this.killGraceTimer);
		if (this.settleExitTimer) clearTimeout(this.settleExitTimer);
		if (this.handoffGraceTimer) clearTimeout(this.handoffGraceTimer);
		if (this.handoffSettleTimer) clearTimeout(this.handoffSettleTimer);
		if (this.handoffEnforceTimer) clearTimeout(this.handoffEnforceTimer);
		if (this.killEscalateTimer) clearTimeout(this.killEscalateTimer);
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


// ── R6: git worktree checkpoints (bounded, best-effort, non-fatal) ─────────

function gitExec(cwd: string, args: string[]): string | null {
	try {
		const out = childProcess.execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 512 * 1024,
		});
		return out.trim();
	} catch {
		return null;
	}
}

function isGitWorktree(cwd: string): boolean {
	return gitExec(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/** Snapshot HEAD + bounded dirty status at run start. */
export function gitCheckpoint(cwd: string): { gitBase: string; gitStatus?: string } | null {
	if (!isGitWorktree(cwd)) return null;
	const head = gitExec(cwd, ["rev-parse", "HEAD"]);
	if (!head) return null;
	const status = gitExec(cwd, ["status", "--porcelain"]);
	const bounded = status ? status.split("\n").slice(0, 40).join("\n").slice(0, 2000) : "";
	return { gitBase: head, ...(bounded ? { gitStatus: bounded } : {}) };
}

/**
 * Bounded post-run worktree delta at finalization: `git diff --stat HEAD`
 * plus untracked files (a killed child's brand-new files are exactly the
 * evidence that matters — `diff HEAD` alone would hide them).
 */
export function gitDeltaSince(cwd: string, _since?: string): string | null {
	if (!isGitWorktree(cwd)) return null;
	const parts: string[] = [];
	const diff = gitExec(cwd, ["diff", "--stat", "HEAD"]);
	if (diff) parts.push(diff);
	const untracked = gitExec(cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (untracked) {
		parts.push(
			untracked
				.split("\n")
				.slice(0, 40)
				.map((f) => `untracked: ${f}`)
				.join("\n"),
		);
	}
	if (parts.length === 0) return null;
	return parts.join("\n").slice(0, 4000);
}

/** Feed detail for a tool start: command/path head (display-safe). */
function feedDetailFor(toolName: string, args?: Record<string, unknown>): string {
	const a = (key: string): string => {
		const v = args?.[key];
		return typeof v === "string" ? v : "";
	};
	const v = a("command") || a("path") || a("pattern") || a("query");
	if (v) return v.replace(/\s+/g, " ").slice(0, 90);
	if (toolName === "handoff") return "structured submission";
	return "";
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
