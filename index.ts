/**
 * delegate — Pi adapter (the ONLY file that imports Pi).
 *
 * Wiring order (§11.1):
 *  1. inert in children (PI_DELEGATE_CHILD=1)
 *  2. construct config/store/roles/application (no child, no timers)
 *  3. register the `delegate` tool
 *  4. register `/delegate` + completion
 *  5. register the `delegate-handoff` renderer
 *  6. register the strict `tool_call` gate (same factory as the tool)
 *  7. lifecycle: session_start / session_tree / before_agent_start /
 *     turn_start / session_shutdown
 */

import { Type } from "typebox";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatDuration, loadConfig, parseDuration, saveConfig } from "./config.ts";
import * as fsSync from "node:fs";
import { delegateVersion } from "./version.ts";
import { HandoffToolParams, validateHandoffSubmission, type HandoffSubmission } from "./handoff.ts";
import { CHILD_NOTE_TYPE, CHILD_QUESTION_TYPE, registerAskParentTool } from "./ask.ts";
import { parseDelegateCommand, delegateCompletions, type DelegateIntent } from "./commands.ts";
import { DELEGATE_ROLES, isRoleName, resolveRole } from "./roles.ts";
import { STRICT_OVERLAY, STRICT_ACTIVE_TOOLS, syncStrictToolSet, resetBlockedCounters } from "./mode.ts";
import { DelegateApplicationImpl } from "./application.ts";
import { DELEGATE_MODE_CUSTOM_TYPE } from "./types.ts";
import type {
	DelegateDetails,
	DelegateRequest,
	DelegateRunResult,
	RunAttemptResult,
	RunStreamUpdate,
	SessionEntryLike,
} from "./types.ts";
import { SettingsPanel, type PanelSnapshot, type PanelActionResult, type PanelSection, type PanelRow } from "./ui/settings-panel.ts";
import { shortModel, formatTokens, formatCost, stateGlyph, progressBar, projectValueCell } from "./ui/format.ts";
import { renderToolCallCard, renderToolPlainCard, renderToolResultCard, type ToolCardLine } from "./ui/tool-card.ts";
import { RunningView, type RunningViewState } from "./ui/running-view.ts";
import { PeekView } from "./ui/peek-view.ts";
import { FeedRing, feedEventsFromTranscript, renderFeedEvents } from "./transcript-feed.ts";
import {
	BackgroundManager,
	BACKGROUND_RESULT_TYPE,
	backgroundResultDisplay,
	deriveBackgroundDescription,
	formatBackgroundDetailText,
	formatBackgroundInventoryText,
	formatBackgroundStartedText,
	makeReceiptReader,
	validateBackgroundDescription,
	type BackgroundDetailView,
	type BackgroundLiveView,
} from "./background.ts";

/** Stable command-driven handoff custom message type (§6.4). */
const HANDOFF_CUSTOM_TYPE = "delegate-handoff";

/**
 * Compact expanded view of a finished run for the TUI: Outcome section,
 * first lines of Changes/Verification/Risks, and the child's last actions.
 * Pure string → string so it is unit-testable without a Pi session.
 */
export function formatRunSummary(
	res: DelegateRunResult,
	options?: { maxLines?: number },
): string {
	const maxLines = options?.maxLines ?? 14;
	const d = res.details;
	const lines: string[] = [];

	if (!res.ok) {
		const err = res.error ? `${res.error.code}: ${res.error.message}` : "unknown failure";
		lines.push(`error: ${err}`);
	} else {
		const handoffLines = res.handoff.split("\n");
		const sections: Array<{ name: string; lines: string[] }> = [];
		for (const line of handoffLines) {
			const h = /^##\s+(.*)$/.exec(line);
			if (h) {
				sections.push({ name: h[1].trim(), lines: [] });
			} else if (sections.length > 0) {
				sections[sections.length - 1].lines.push(line);
			}
		}
		if (sections.length === 0) {
			// No structured headings — show the first few non-empty lines.
			let shown = 0;
			for (const line of handoffLines) {
				if (!line.trim()) continue;
				lines.push(line);
				if (++shown >= 6) break;
			}
		} else {
			for (const s of sections) {
				lines.push(`## ${s.name}`);
				if (s.name === "Outcome") {
					lines.push(...s.lines);
				} else {
					let kept = 0;
					for (const line of s.lines) {
						if (!line.trim()) continue;
						lines.push(line);
						if (++kept >= 2) break;
					}
				}
			}
		}
	}

	const actions = (d.displayItems ?? [])
		.map((i) => (i.type === "text" ? i.text : `tool ${i.name}`))
		.filter(Boolean);
	if (actions.length > 0) {
		lines.push("", "last actions:");
		for (const action of actions.slice(-5)) lines.push(`  · ${action}`);
	}

	if (d.outputTruncated || d.stderrPath) {
		lines.push("", `[Full transcript: ${d.transcriptPath}]`);
	}

	const out = lines.join("\n").split("\n");
	if (out.length > maxLines) {
		const head = out.slice(0, Math.max(1, maxLines - 1));
		return [...head, `… (${out.length - head.length} more lines — see transcript)`].join("\n");
	}
	return out.join("\n");
}

/**
 * Child-mode surface: the delegated child gets EXACTLY ONE delegate tool —
 * the mandatory structured `handoff`. The child's final report is a
 * protocol step (schema-validated, retried on error, enforced by the
 * runner), never free text the harness hopes has the right shape.
 */
function registerChildHandoffTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"MANDATORY final report for this delegated run. Your run does not complete until this tool " +
			"has been called with a valid submission; free-text endings are rejected and you will be re-prompted. " +
			"When terminated mid-work, call it immediately with outcome=partial.",
		parameters: HandoffToolParams,
		async execute(_toolCallId, params): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: { delegateHandoff?: HandoffSubmission; rejected?: boolean; errors?: string[] };
			isError?: boolean;
		}> {
			const validation = validateHandoffSubmission(params);
			if (!validation.ok) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"handoff REJECTED — fix every field listed below and call the handoff tool again:\n" +
								validation.errors.map((e) => `- ${e}`).join("\n"),
						},
					],
					details: { rejected: true, errors: validation.errors },
					isError: true,
				};
			}
			const value = validation.value!;
			return {
				content: [
					{
						type: "text" as const,
						text: `handoff accepted (${value.outcome}) — you may now end your turn. Do not write another final message.`,
					},
				],
				details: { delegateHandoff: value },
			};
		},
	});
}

export default function delegateExtension(pi: ExtensionAPI) {
	// 1. The child never reactivates the parent surface (POL: no recursion) —
	//    it registers ONLY the mandatory structured-handoff tool.
	if (process.env.PI_DELEGATE_CHILD === "1") {
		registerChildHandoffTool(pi);
		// R17/R18: background children get the ask_parent channel (a
		// foreground child asking would deadlock the parent turn by
		// construction — enforced here at registration, not by prompt).
		const askDir = process.env.PI_DELEGATE_ASK_DIR;
		if (askDir) {
			registerAskParentTool(pi, {
				askDir,
				timeoutMs: Number(process.env.PI_DELEGATE_ASK_TIMEOUT_MS) > 0 ? Number(process.env.PI_DELEGATE_ASK_TIMEOUT_MS) : 600_000,
				maxQuestions: Number(process.env.PI_DELEGATE_ASK_MAX) > 0 ? Number(process.env.PI_DELEGATE_ASK_MAX) : 5,
			});
		}
		return;
	}
	// 2. Construct state — no child, no timers at load time.
	// PI_DELEGATE_AGENT_DIR is a test override; production uses getAgentDir().
	const agentDir = process.env.PI_DELEGATE_AGENT_DIR || getAgentDir();
	const { config, unknownKeys, recoveredFromCorrupt, corruptEvidencePath } = loadConfig(agentDir);
	const app = new DelegateApplicationImpl({ agentDir, config });
	// Startup orphan recovery (§10.6): receipts only; never kills PIDs.
	app.markOrphansOnStartup();

	// R15: footer state — composes strict-mode + live background count.
	let liveBgCount = 0;
	let footerUi: { setStatus(key: string, text?: string): void } | null = null;
	const refreshFooter = () => {
		const parts: string[] = [];
		if (app.isStrict()) parts.push("delegate: strict");
		if (liveBgCount > 0) parts.push(`▴${liveBgCount}bg`);
		try {
			footerUi?.setStatus("delegate", parts.length ? parts.join(" · ") : undefined);
		} catch {
			// headless: no footer
		}
	};

	// R8–R13: background run manager. Delivery + ledger writes are ports so
	// the manager stays Pi-free and unit-testable; formatRunText is captured
	// by closure (defined below, called only at terminal delivery).
	const background = new BackgroundManager({
		sendMessage: (message, options) => {
			pi.sendMessage(message, options);
		},
		appendEntry: (customType, data) => {
			pi.appendEntry(customType, data);
		},
		maxBackgroundRuns: () => app.backgroundLimit(),
		formatRun: (res) => formatRunText(res),
		readReceipt: makeReceiptReader(agentDir),
		onInventoryChange: (count) => {
			liveBgCount = count;
			refreshFooter();
		},
	});

	const say = (ctx: { hasUI: boolean; ui: { notify(message: string, level?: "info" | "warning" | "error"): void } }, text: string, level: "info" | "warning" | "error" = "info") => {
		// Essential output uses stdout (§6.1); notify is supplemental only.
		// In headless RPC, console.log is captured by the host — surface the
		// full text on the message channel so clients can observe it.
		console.log(text);
		// notify is protocol-visible (TUI toast + RPC extension_ui_request).
		try {
			ctx.ui.notify(text, level);
		} catch {
			// ignore
		}
		if (!ctx.hasUI) {
			try {
				pi.sendMessage(
					{ customType: "delegate-message", content: text, display: true, details: {} },
					{ triggerTurn: false },
				);
			} catch {
				// last resort: nothing else available
			}
		}
	};
	const lastLine = (text: string): string => text.split("\n").filter(Boolean).pop() ?? text;

	const modelString = (ctx: ExtensionContext): string => {
		const m = ctx.model as { provider?: string; id?: string } | undefined;
		if (!m?.provider || !m.id) return "";
		return `${m.provider}/${m.id}`;
	};

	const thinkingOf = (ctx: ExtensionContext): string | undefined => {
		try {
			return (ctx as unknown as { thinkingLevel?: string }).thinkingLevel ?? pi.getThinkingLevel() ?? undefined;
		} catch {
			return undefined;
		}
	};

	const buildRequest = (
		task: string,
		role: "general" | "research",
		source: "tool" | "command",
		ctx: ExtensionContext,
		timeoutMs?: number,
		extras?: { model?: string; resumeFrom?: string; background?: boolean; description?: string },
	): DelegateRequest => ({
		task,
		role,
		source,
		cwd: ctx.cwd ?? process.cwd(),
		parentModel: modelString(ctx),
		thinkingLevel: thinkingOf(ctx),
		projectTrusted: ctx.isProjectTrusted(),
		projectRoot: ctx.cwd ?? process.cwd(),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(extras?.model ? { model: extras.model } : {}),
		...(extras?.resumeFrom ? { resumeFrom: extras.resumeFrom } : {}),
		...(extras?.background ? { background: true } : {}),
		...(extras?.description ? { description: extras.description } : {}),
	});

	const refreshDoctor = (ctx: ExtensionContext) => {
		try {
			app.refreshDoctorContext({
				model: modelString(ctx) || undefined,
				activeTools: pi.getActiveTools(),
				registeredTools: pi.getAllTools().map((t: { name: string }) => t.name),
			});
		} catch {
			// doctor context is best-effort
		}
	};

	// ── Mode transition context ─────────────────────────────────────────────

	const modeCtx = (ctx: ExtensionCommandContext) => ({
		isBusy: () => !ctx.isIdle(),
		requestAbortConfirmation: async (): Promise<boolean> => {
			if (!ctx.hasUI) return false; // headless fails E_PARENT_BUSY (§8.4)
			return ctx.ui.confirm(
				"Enable strict delegation mode?",
				"The parent turn is running. Abort it now and switch the parent to coordinator-only?",
			);
		},
		abort: () => {
			try {
				ctx.abort();
			} catch {
				// ignore
			}
		},
		waitForIdle: async () => {
			const deadline = Date.now() + 20_000;
			while (!ctx.isIdle() && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 50));
			}
			if (!ctx.isIdle()) throw new Error("parent did not reach idle");
		},
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: (names: string[]) => pi.setActiveTools(names),
		persistModeEntry: (entry: { schemaVersion: 1; enabled: boolean; changedAt: string; source: "command" }) => {
			pi.appendEntry(DELEGATE_MODE_CUSTOM_TYPE, entry);
		},
		setFooterStatus: (text: string | undefined) => ctx.ui.setStatus("delegate", text),
		notify: (message: string, level: "info" | "warning" | "error") => ctx.ui.notify(message, level),
	});

	// ── Result rendering helpers ────────────────────────────────────────────

	const formatRunText = (res: DelegateRunResult): string => {
		const d = res.details;
		const stateLabel =
			d.state === "succeeded" ? "completed"
			: d.state === "cancelled" ? "cancelled"
			: d.state.startsWith("timed_out") ? d.state.replace("_", " ")
			: d.state;
		const secs = Math.round(d.durationMs / 1000);
		const head =
			`[delegate v${delegateVersion()} · ${d.runId} · ${d.role} · ${stateLabel} in ${secs}s` +
			`${d.model ? ` · ${d.model}` : ""}${d.timeoutInfo ? ` · ${d.timeoutInfo}` : ""}]`;
		if (!res.ok) {
			const parts = [head];
			const err = res.error ? `${res.error.code}: ${res.error.message}` : "unknown failure";
			if (d.state === "cancelled") {
				// A cancellation is user intent, not a failure — neutral line,
				// plus the resume path when a durable session exists.
				parts.push(`cancelled — ${res.error?.message ?? "aborted"}; no handoff.`);
				if (d.sessionPath) parts.push(`resume: re-issue with resumeFrom: ${d.runId} to continue in the same child context.`);
				if (res.details.partialHandoff) parts.push("", "partial handoff (captured at kill):", res.details.partialHandoff);
				if (res.modelNote) parts.push(`note: ${res.modelNote}`);
				parts.push(`transcript: ${d.transcriptPath}`);
				return parts.join("\n");
			}
			parts.push(`error: ${err}`);
			// R2: the killed child's own account of its partial work.
			if (res.details.partialHandoff) {
				parts.push("", "partial handoff (captured at kill):", res.details.partialHandoff);
			}
			if (res.modelNote) parts.push(`note: ${res.modelNote}`);
			parts.push(`transcript: ${d.transcriptPath}`);
			if (d.sessionPath) parts.push(`session: ${d.sessionPath} (resumable via resumeFrom: ${d.runId})`);
			return parts.join("\n");
		}
		const parts = [head, "", res.handoff];
		if (d.outputTruncated || d.stderrPath) {
			parts.push("", `[Full transcript: ${d.transcriptPath}]`);
		}
		return parts.join("\n");
	};

	const usageField = (res: DelegateRunResult) => {
		const u = res.details.usage;
		return {
			input: u.input,
			output: u.output,
			cacheRead: u.cacheRead,
			cacheWrite: u.cacheWrite,
			totalTokens: u.contextTokens || u.input + u.output + u.cacheRead + u.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
		};
	};

	// ── 3. Model tool ───────────────────────────────────────────────────────

	const DelegateParams = Type.Object({
		task: Type.String({ minLength: 1 }),
		role: Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("research")])),
		timeout: Type.Optional(Type.String({
			description:
				"Optional per-run hard timeout, e.g. '90s', '10m', '2h', '1d' or bare ms. " +
				"Use it when the subtask is expected to run longer than the configured default; it overrides the project/user config base. " +
				"Effective inactivity = min(config, hard/2); a single tool call longer than that is killed unless the in-flight-tool budget covers it — " +
				"for long validation/benchmark work set timeout at 2x the longest expected tool call.",
		})),
		model: Type.Optional(Type.String({
			description:
				"Optional child model pin as 'provider/model-id'. Without it the child silently inherits the parent's CURRENT model — " +
				"if the parent switches models mid-session (e.g. a usage-limit fallback), children follow. Pin this for model-sensitive work.",
		})),
		resumeFrom: Type.Optional(Type.String({
			description:
				"Resume a prior run's durable child session: pass its runId. The new child re-enters that exact context " +
				"(earlier turns included) with your task as the continuation prompt — no cold re-explanation. " +
				"Works for runs whose receipt records a sessionPath (post-0.2.0) and whose session file still exists.",
		})),
		background: Type.Optional(Type.Boolean({
			description:
				"Run this delegation in the background: the call returns a runId immediately and the terminal report " +
				"arrives later as a message. Use it for long builds, test matrices, or research that should not block " +
				"this turn. Requires 'description'. Poll with the delegate_status pattern or wait for the report message.",
		})),
		description: Type.Optional(Type.String({
			description:
				"Required with background=true: a 3-to-6-word purpose summary for the user, e.g. 'Run full test matrix'. " +
				"Describes the work, not the mechanism. Single line.",
		})),
	});

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate a self-contained subtask to an isolated child Pi session with a bounded final handoff. " +
			"Roles: general (implementation, write-capable) and research (read-only web research via Firecrawl, optionally supplemented by Reddit). " +
			"The child does not see parent history; include all objective, relevant paths, constraints, and acceptance criteria in the task.",
		promptSnippet: "Delegate a bounded subtask (implementation or research) to an isolated child session",
		promptGuidelines: [
			"Use delegate autonomously when a bounded subtask would consume substantial parent context, benefits from a specialist tool ceiling, or needs independent verification.",
			"Pass the objective, relevant paths, constraints, and acceptance criteria in the delegate task text; the child cannot see parent history.",
			"Do not use delegate for trivial one-step work, or when most of the parent history would have to be copied into the task.",
			"Parallel delegate calls are fine: they queue and run back-to-back (one child at a time) — every call gets a real result; do not re-issue on 'queue full', wait for the in-flight results instead.",
			"Use background=true (with a 3–6-word description) for long builds, test matrices, or research that should not block this turn: the call returns a runId immediately and the terminal report arrives later as a message. Check progress with delegate_status; do not wait inline.",
			"Treat background terminal reports as internal work events: acknowledge them to the user with at most one line; do not re-narrate the handoff unless material.",
			"On E_BACKGROUND_FULL, do not re-issue the task: check delegate_status and wait for terminal reports to free slots.",
			"Steer live background runs with delegate_send (course corrections apply at the child's next model call); reserve resumeFrom for finished runs.",
			"A timed-out run leaves a partialHandoff, a git checkpoint and a resumable child session: pass resumeFrom: <runId> to continue in the same context instead of re-explaining, and inspect the receipt's gitDelta before repairing anything.",
			"Pin model: 'provider/model-id' when the child must not silently follow the parent's current model (e.g. after a mid-session model fallback).",
			"For long validation/benchmark subtasks set timeout to at least 2x the longest expected single tool call.",
			"While delegation mode is active, all substantive work and verification must use delegate; the parent is coordination-only.",
		],
		parameters: DelegateParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Strict mode invariant also holds here: only delegate runs anyway.
			let timeoutMs: number | undefined;
			if (typeof params.timeout === "string" && params.timeout.trim()) {
				try {
					timeoutMs = parseDuration(params.timeout);
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: (error as Error).message }],
					details: {} satisfies Record<string, unknown>,
					isError: true,
					};
				}
			}
			const modelExtra = typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;
			const resumeExtra = typeof params.resumeFrom === "string" && params.resumeFrom.trim() ? params.resumeFrom.trim() : undefined;

			// R8: background path — validate, slot-check, spawn, return runId.
			if (params.background === true) {
				const desc = validateBackgroundDescription(params.description);
				if (!desc.ok) {
					return {
						content: [{ type: "text" as const, text: `description invalid: ${desc.error}` }],
						details: {} satisfies Record<string, unknown>,
						isError: true,
					};
				}
				const slot = background.slotError();
				if (slot) {
						return {
						content: [{ type: "text" as const, text: `${slot.code}: ${slot.message}` }],
						details: { background: true, busy: true } satisfies Record<string, unknown>,
						isError: true,
					};
				}
				const request = buildRequest(params.task, params.role ?? config.defaultRole, "tool", ctx, timeoutMs, {
					model: modelExtra,
					resumeFrom: resumeExtra,
					background: true,
					description: desc.value,
				});
				refreshDoctor(ctx);
				const attempt = app.runBackground(request, {
					onAsk: (ask) => background.onAsk(ask),
				});
				if ("error" in attempt) {
					return {
						content: [{ type: "text" as const, text: formatRunText(attempt.error) }],
						details: attempt.error.details satisfies DelegateDetails,
						isError: true,
					};
				}
				background.register(attempt.handle);
				return {
					content: [{ type: "text" as const, text: formatBackgroundStartedText(attempt.handle.runId, attempt.handle.role, attempt.handle.description) }],
					details: {
						runId: attempt.handle.runId,
						role: attempt.handle.role,
						background: true,
						description: attempt.handle.description,
					} satisfies Record<string, unknown>,
				};
			}

			const request = buildRequest(params.task, params.role ?? config.defaultRole, "tool", ctx, timeoutMs, {
				model: modelExtra,
				resumeFrom: resumeExtra,
			});
			refreshDoctor(ctx);
			const hooks = {
				abortSignal: signal ?? undefined,
				onUpdate: (u: RunStreamUpdate) => {
					const head = `[delegate v${delegateVersion()} ${shortModel(u.model) || u.role} · ${u.phase} · ${Math.round(u.elapsedMs / 1000)}s]`;
					const tail = (u.lastActions ?? []).slice(-2).map((l) => `  ${l}`);
					onUpdate?.({
						content: [{ type: "text", text: tail.length ? `${head}\n${tail.join("\n")}` : head }],
						details: { runId: u.runId, phase: u.phase },
					});
				},
			};
			const attempt = await app.run(request, hooks);
			if ("busy" in attempt && attempt.busy) {
				return {
					content: [{ type: "text" as const, text: attempt.error.message }],
					details: { busy: true, runId: attempt.runId, role: attempt.role } satisfies Record<string, unknown>,
					isError: true,
				};
			}
			const res = attempt as DelegateRunResult;
			return {
				content: [{ type: "text" as const, text: formatRunText(res) }],
				details: res.details satisfies DelegateDetails,
				...(res.ok ? {} : { isError: true }),
				usage: usageField(res),
			};
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderCall(args: any, theme: any) {
			const role = typeof args.role === "string" ? args.role : config.defaultRole;
			const task = typeof args.task === "string" ? args.task : "";
			const modelBit = typeof args.model === "string" && args.model ? ` · ${shortModel(args.model)}` : "";
			return renderToolCallCard(theme, {
				title: "delegate",
				subject: role,
				qualifier: `${modelBit}: ${task.length > 64 ? `${task.slice(0, 61)}…` : task}`,
			});
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderResult(result: any, options: any, theme: any) {
			const d = result.details as DelegateDetails | undefined;
			if (!d?.runId) {
				const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").filter(Boolean).join("\n");
				return renderToolPlainCard(text);
			}
			const u = d.usage ?? ({} as DelegateDetails["usage"]);
			// Neutral, non-color-alone state word (cancelled ≠ failed ≠ timeout).
			const bits = [
				`${Math.round(d.durationMs / 1000)}s`,
				...(d.model ? [shortModel(d.model)] : []),
				`↑${formatTokens(u.input)} ↓${formatTokens(u.output)}`,
				...(u.cost ? [formatCost(u.cost)] : []),
			];
			const header = `→ ${d.runId.slice(-16)}`;
			if (!options?.expanded) {
				// Inline tail ≤5 — partial handoff (timeout/cancel) or reason, never bare.
				const tailSrc: string = d.partialHandoff ?? (d.state === "succeeded" ? "" : (result.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" ").split("\n")[0] ?? "");
				const tail = tailSrc ? tailSrc.split("\n").map((l: string) => l.trim()).filter(Boolean).slice(0, 5) : [];
				const detailLines: ToolCardLine[] = tail.map((t) => ({ text: `  ${t}` }));
				if (d.outputTruncated && d.transcriptPath) detailLines.push({ text: `  transcript: ${d.transcriptPath}` });
				return renderToolResultCard(theme, { header, lead: d.role, state: d.state, stateBits: bits, detailLines });
			}
			// Expanded: identity + canonical summary + resume hint.
			const summary = formatRunSummary(result as unknown as DelegateRunResult);
			const detailLines: ToolCardLine[] = [];
			if (d.sessionPath && d.state !== "succeeded") detailLines.push({ text: `  resume: resumeFrom ${d.runId}` });
			if (d.transcriptPath) detailLines.push({ text: `  transcript: ${d.transcriptPath}` });
			return renderToolResultCard(theme, {
				header,
				lead: d.role,
				state: d.state,
				stateBits: bits,
				plainLines: summary ? summary.split("\n") : undefined,
				detailLines,
			});
		},
	});

	// ── R14: delegate_status tool (background inventory / run detail) ─────

	const backgroundLiveViews = (): BackgroundLiveView[] =>
		background.liveRuns().map((r) => {
			const stream = app.getBackgroundStream(r.runId);
			return {
				runId: r.runId,
				role: r.role,
				description: r.description,
				detached: r.detached,
				...(stream?.update ? { phase: stream.update.phase, elapsedMs: stream.update.elapsedMs, ...(stream.update.openTools?.length ? { openTools: stream.update.openTools } : {}), ...(stream.update.model ? { model: stream.update.model } : {}) } : {}),
			};
		});

	const backgroundStatusText = (): string =>
		formatBackgroundInventoryText({
			limit: app.backgroundLimit(),
			live: backgroundLiveViews(),
			queue: app.queuedRunCount(),
			recent: app.backgroundRecentRuns(3),
		});

	const backgroundDetailText = (runId: string, limit?: number): string => {
		const receipt = (() => {
			try {
				return app.inspect(runId, false).metadata;
			} catch {
				return null;
			}
		})();
		const stream = app.getBackgroundStream(runId);
		if (!receipt && !stream) return `[delegate background] unknown run ${runId}`;
		const maxEvents = limit ?? 8;
		let activityTail: string[] = [];
		if (stream && stream.events.length > 0) {
			activityTail = renderFeedEvents([...stream.events], { startMs: Date.now() - (stream.update?.elapsedMs ?? 0), maxChars: 140, maxEvents }).slice(-maxEvents);
		} else if (receipt?.transcriptPath) {
			try {
				const { startMs, events } = feedEventsFromTranscript(receipt.transcriptPath);
			activityTail = renderFeedEvents(events, { startMs, maxChars: 140, maxEvents }).slice(-maxEvents);
			} catch {
				// transcript read is best-effort
			}
		}
		const live = stream?.update ? { phase: stream.update.phase, elapsedMs: stream.update.elapsedMs, ...(stream.update.openTools?.length ? { openTools: stream.update.openTools } : {}) } : undefined;
		return formatBackgroundDetailText({
			runId,
			role: (receipt?.role ?? background.liveRuns().find((r) => r.runId === runId)?.role ?? "general") as "general" | "research",
			...(receipt?.description ? { description: receipt.description } : {}),
			state: (receipt?.state ?? "running") as never,
			...(receipt?.model ? { model: receipt.model } : {}),
			...(receipt?.startedAt ? { startedAt: receipt.startedAt } : {}),
			...(receipt?.finishedAt ? { finishedAt: receipt.finishedAt } : {}),
			...(receipt?.startedAt && receipt?.finishedAt ? { durationMs: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt) } : {}),
			...(live ? { live } : {}),
			activityTail,
			...(receipt?.finalHandoff ? { handoffPreview: receipt.finalHandoff } : receipt?.partialHandoff ? { handoffPreview: receipt.partialHandoff } : {}),
			...(receipt?.sessionPath ? { sessionPath: receipt.sessionPath } : {}),
			background: true,
		});
	};

	const DelegateStatusParams = Type.Object({
		runId: Type.Optional(Type.String({ description: "Optional runId returned by a background delegate call. Omit to list all background runs." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Optional cap for recent-activity lines (default 8)." })),
	});

	pi.registerTool({
		name: "delegate_status",
		label: "Background run status",
		description:
			"Check asynchronous (background) delegate runs. Without runId: slot usage, every live background run (state, elapsed, in-flight tool), and the recent terminal runs. " +
			"With runId: one run's detail — live activity tail or post-mortem feed, handoff preview, and the resumeFrom hint for interrupted runs. " +
			"Background runs deliver their terminal report as a message automatically; this tool is for checking progress, not for waiting.",
		promptSnippet: "Check background delegate runs (inventory or one run's detail)",
		promptGuidelines: [
			"Poll delegate_status sparingly — background terminal reports arrive as messages on their own; do not busy-poll.",
		],
		parameters: DelegateStatusParams,
		async execute(_toolCallId, params) {
			const runId = typeof params.runId === "string" ? params.runId.trim() : "";
			const text = runId
				? backgroundDetailText(runId, typeof params.limit === "number" ? params.limit : undefined)
				: backgroundStatusText();
			return { content: [{ type: "text" as const, text }], details: { runId: runId || undefined } satisfies Record<string, unknown> };
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderCall(args: any, theme: any) {
			const runId = typeof args.runId === "string" && args.runId ? args.runId.slice(-12) : "all";
			return renderToolCallCard(theme, { title: "delegate_status", subject: "background", qualifier: runId });
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderResult(result: any, theme: any) {
			const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").filter(Boolean).join("\n");
			const first = text.split("\n").slice(0, 6).join("\n");
			return renderToolPlainCard(first || text);
		},
	});

	// ── R16: delegate_send tool (parent → child steering) ──────────────────

	pi.registerTool({
		name: "delegate_send",
		label: "Steer background run",
		description:
			"Send a steering message to a LIVE background delegate run. The message is queued before the child's next model call (pi steering semantics — it never interrupts in-flight work). " +
			"Use it for course corrections and additional instructions on a running background task. " +
			"Foreground runs cannot be steered; finished runs must be continued with delegate({ resumeFrom: … }).",
		promptSnippet: "Steer a live background delegate run",
		promptGuidelines: [
			"Prefer delegate_send for course corrections on live background runs; use resumeFrom only after a run finished.",
		],
		parameters: Type.Object({
			runId: Type.String({ description: "The runId returned by the background delegate call." }),
			message: Type.String({ minLength: 1, description: "The instruction for the child. Be specific and self-contained — it is applied to the child's ongoing task context." }),
		}),
		async execute(_toolCallId, params) {
			const runId = typeof params.runId === "string" ? params.runId.trim() : "";
			const message = typeof params.message === "string" ? params.message : "";
			if (!runId || !message) {
				return {
					content: [{ type: "text" as const, text: "delegate_send requires runId and message." }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}
			const result = background.send(runId, message);
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `E_STEER_FAILED: ${result.error}` }],
					details: { runId } as Record<string, unknown>,
					isError: true,
				};
			}
			return {
				content: [{ type: "text" as const, text: `Steering accepted for background run ${runId}. The child applies it at its next model call; watch for the terminal report or check delegate_status.` }],
				details: { runId, steered: true } as Record<string, unknown>,
			};
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderCall(args: any, theme: any) {
			const runId = typeof args.runId === "string" ? args.runId.slice(-12) : "?";
			return renderToolCallCard(theme, { title: "delegate_send", subject: "steer", qualifier: runId });
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderResult(result: any, theme: any) {
			const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").filter(Boolean).join("\n");
			return renderToolPlainCard(text.split("\n")[0] ?? text);
		},
	});

	// ── R17: delegate_answer tool (unblock a waiting child) ────────────────

	pi.registerTool({
		name: "delegate_answer",
		label: "Answer child question",
		description:
			"Answer a delegated child's pending ask_parent question. The blocked child resumes the moment your answer lands. " +
			"Be terse and directive; do not narrate the exchange to the user unless material. If you cannot answer, say so — the child falls back to its best judgment when the ask budget expires.",
		promptSnippet: "Answer a delegated child's pending question",
		promptGuidelines: [
			"Answer pending child questions promptly with delegate_answer — the child is blocked until you do.",
		],
		parameters: Type.Object({
			runId: Type.String({ description: "The runId from the delegate-child-question message." }),
			answer: Type.String({ minLength: 1, maxLength: 2000, description: "Your answer, self-contained and directive. The child sees exactly this text." }),
		}),
		async execute(_toolCallId, params) {
			const runId = typeof params.runId === "string" ? params.runId.trim() : "";
			const answer = typeof params.answer === "string" ? params.answer.trim() : "";
			if (!runId || !answer) {
				return {
					content: [{ type: "text" as const, text: "delegate_answer requires runId and answer." }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}
			const result = background.answer(runId, answer, "model");
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `E_ANSWER_FAILED: ${result.error}` }],
					details: { runId } as Record<string, unknown>,
					isError: true,
				};
			}
			return {
				content: [{ type: "text" as const, text: `Answer delivered to background run ${runId}; the child is resuming.` }],
				details: { runId, answered: true } as Record<string, unknown>,
			};
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderCall(args: any, theme: any) {
			const runId = typeof args.runId === "string" ? args.runId.slice(-12) : "?";
			return renderToolCallCard(theme, { title: "delegate_answer", subject: "answer", qualifier: runId });
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderResult(result: any, theme: any) {
			const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").filter(Boolean).join("\n");
			return renderToolPlainCard(text.split("\n")[0] ?? text);
		},
	});

	// ── R15/R17/R18: question + note renderers (? asks / ℹ note) ──────────

	pi.registerMessageRenderer(CHILD_QUESTION_TYPE, (message: { content?: string | unknown[]; details?: unknown }) => {
		const d = (message.details ?? {}) as { runId?: string; description?: string; topic?: string };
		const raw = message.content;
		const text =
			typeof raw === "string" ? raw
			: Array.isArray(raw) ? raw.map((b) => (b as { text?: string })?.text ?? "").join("\n")
			: "";
		const parts = text.split("\n\n");
		const body = parts.length > 2 ? parts.slice(2).join("\n\n") : text;
		return new Text(`? background ${d.runId ?? "?"}${d.description ? ` · ${d.description}` : ""}: asks (${d.topic ?? "?"})\n\n${body}`, 0, 0);
	});

	pi.registerMessageRenderer(CHILD_NOTE_TYPE, (message: { content?: string | unknown[]; details?: unknown }) => {
		const d = (message.details ?? {}) as { runId?: string; description?: string; topic?: string };
		const raw = message.content;
		const text =
			typeof raw === "string" ? raw
			: Array.isArray(raw) ? raw.map((b) => (b as { text?: string })?.text ?? "").join("\n")
			: "";
		const parts = text.split("\n\n");
		const body = parts.length > 2 ? parts.slice(2).join("\n\n") : text;
		return new Text(`ℹ background ${d.runId ?? "?"}${d.description ? ` · ${d.description}` : ""}: note (${d.topic ?? "?"})\n\n${body}`, 0, 0);
	});

	// ── Handoff custom message renderer (§6.4) ─────────────────────────────

	pi.registerMessageRenderer(HANDOFF_CUSTOM_TYPE, (message: { content?: string | unknown[]; details?: unknown }) => {
		const d = (message.details ?? {}) as { runId?: string; role?: string; state?: string };
		const raw = message.content;
		const text =
			typeof raw === "string" ? raw
			: Array.isArray(raw) ? raw.map((b) => (b as { text?: string })?.text ?? "").join("\n")
			: "";
		return new Text(`[delegate ${d.runId ?? "?"} · ${d.role ?? "?"} · ${d.state ?? "?"}]\n\n${text}`, 0, 0);
	});

	// ── R15: background result renderer (neutral glyph+word, no model-only text)

	pi.registerMessageRenderer(BACKGROUND_RESULT_TYPE, (message: { content?: string | unknown[]; details?: unknown }) => {
		const d = (message.details ?? {}) as { runId?: string; state?: string; description?: string };
		const raw = message.content;
		const text =
			typeof raw === "string" ? raw
			: Array.isArray(raw) ? raw.map((b) => (b as { text?: string })?.text ?? "").join("\n")
			: "";
		return new Text(backgroundResultDisplay(text, d), 0, 0);
	});

	// ── Command execution ───────────────────────────────────────────────────

	const sendHandoffMessage = (res: DelegateRunResult) => {
		// Command-run handoff: display only, never triggers a parent turn.
		try {
			pi.sendMessage(
				{
					customType: HANDOFF_CUSTOM_TYPE,
					content: res.handoff || res.error?.message || "",
					display: true,
					details: { runId: res.details.runId, role: res.details.role, state: res.details.state },
				},
				{ triggerTurn: false },
			);
		} catch {
			// headless modes simply console.log the same text
		}
	};

	const runCommandForeground = async (task: string, role: "general" | "research", ctx: ExtensionCommandContext, timeoutMs?: number, extras?: { resumeFrom?: string }): Promise<void> => {
		const request = buildRequest(task, role, "command", ctx, timeoutMs, extras);
		refreshDoctor(ctx);
		let lastText = `[delegate] starting ${role} run…`;
		const hooks = {
			onUpdate: (u: RunStreamUpdate) => {
				lastText = `[delegate ${u.runId} · ${u.role} · ${u.phase} · ${Math.round(u.elapsedMs / 1000)}s] ${u.lastActions.slice(-1)[0] ?? ""}`.trim();
			},
		};
		if (ctx.mode === "tui") {
			let res: RunAttemptResult | undefined;
			const viewState: RunningViewState = {
				runId: "",
				role: request.role,
				phase: "starting",
				elapsedMs: 0,
				feedLines: [],
			};
			// Live feed: every child event lands in the ring; the panel renders
			// the bounded tail on each host refresh (1 s + event-driven).
			const feed = new FeedRing(120);
			let feedStartMs = 0;
			let hardMs: number | undefined;
			const feedLines = (): string[] => {
				if (feed.all().length === 0) return [];
				return renderFeedEvents([...feed.all()], {
					startMs: feedStartMs || Date.now(),
					maxChars: 150,
					maxEvents: 6,
				});
			};
			const runPromise = app.run(request, {
				...hooks,
				onUpdate: (u: RunStreamUpdate) => {
					hooks.onUpdate?.(u);
					viewState.runId = u.runId;
					viewState.role = u.role;
					viewState.phase = u.phase;
					viewState.elapsedMs = u.elapsedMs;
					viewState.model = u.model;
					viewState.openTools = u.openTools;
					viewState.turns = u.usage?.turns;
					viewState.tokens = { input: u.usage?.input, output: u.usage?.output };
					if (!feedStartMs) feedStartMs = Date.now() - u.elapsedMs;
				},
				onEvent: (event) => {
					feed.push(event);
				},
			});
			// Effective hard cap for the progress bar: per-run > project > user.
			try {
				const s = app.getStatus(pi.getActiveTools(), ctx.cwd ?? process.cwd());
				hardMs = request.timeoutMs ?? s.timeouts.hardMs;
			} catch {
				hardMs = undefined;
			}
			viewState.hardMs = hardMs;
			let refreshTimer: ReturnType<typeof setInterval> | undefined;
			const outcome = await ctx.ui.custom<{ cancelled?: boolean } | undefined>(
				(tui, theme, keybindings, done) => {
					refreshTimer = setInterval(() => {
						viewState.elapsedMs = feedStartMs ? Date.now() - feedStartMs : viewState.elapsedMs;
						viewState.feedLines = feedLines();
						tui.requestRender();
					}, 1000);
					return new RunningView({
						theme,
						keybindings,
						state: () => {
							viewState.feedLines = feedLines();
							return viewState;
						},
						done,
					});
				},
			);
			if (refreshTimer) clearInterval(refreshTimer);
			if (outcome?.cancelled) {
				await app.cancel();
				say(ctx, `[delegate] cancellation requested; the run finalizes with its terminal receipt.`);
				// Let the run settle so its receipt finalizes (bounded wait).
				try {
					const bounded = await Promise.race([
						runPromise,
						new Promise<null>((r) => setTimeout(() => r(null), (config.killGraceMs ?? 5000) + 6000)),
					]);
					if (bounded) res = bounded;
				} catch {
					// ignore
				}
			} else {
				res = await runPromise;
			}
			if (res && !("busy" in res && res.busy)) {
				const r = res as DelegateRunResult;
				say(ctx, formatRunText(r));
				sendHandoffMessage(r);
			} else if (res && "busy" in res) {
				say(ctx, `[delegate] busy — active run ${res.runId} (${res.role}). Use /delegate cancel.`, "warning");
			}
			return;
		}
		const res = await app.run(request, hooks);
		if ("busy" in res && res.busy) {
			say(ctx, `[delegate] busy — active run ${res.runId} (${res.role}). Use /delegate cancel.`, "warning");
			return;
		}
		const r = res as DelegateRunResult;
		say(ctx, formatRunText(r));
		sendHandoffMessage(r);
	};

	// R20: user-facing background launch — /delegate bg and the dashboard
	// action spawn a background run (description derived from the task's
	// first line) and return immediately; the report arrives later.
	const runCommandBackground = async (task: string, role: "general" | "research", ctx: ExtensionCommandContext, timeoutMs?: number): Promise<void> => {
		const desc = deriveBackgroundDescription(task);
		if (!desc.ok) {
			say(ctx, `[delegate] ${desc.error}`, "error");
			return;
		}
		const slot = background.slotError();
		if (slot) {
			say(ctx, `[delegate] ${slot.code}: ${slot.message}`, "warning");
			return;
		}
		const request = buildRequest(task, role, "command", ctx, timeoutMs, {
			background: true,
			description: desc.value,
		});
		refreshDoctor(ctx);
		const attempt = app.runBackground(request, {
			onAsk: (ask) => background.onAsk(ask),
		});
		if ("error" in attempt) {
			say(ctx, formatRunText(attempt.error), "error");
			return;
		}
		background.register(attempt.handle);
		say(ctx, formatBackgroundStartedText(attempt.handle.runId, attempt.handle.role, attempt.handle.description));
	};

	const statusText = (ctx: ExtensionContext): string => {
		const s = app.getStatus(pi.getActiveTools(), ctx.cwd ?? process.cwd());
		const lines = ["[delegate]", `version: v${delegateVersion()} (loaded at session start; /reload picks up newer installs)`, `mode: ${s.modeEnabled ? "strict" : "normal"}`];
		lines.push(`parent tools: ${s.modeEnabled ? "delegate only" : "normal active set"}`);
		lines.push(`active run: ${s.activeRun ? `${s.activeRun.runId} (${s.activeRun.role})` : "none"}`);
		const queued = app.queuedRunCount();
		lines.push(`queue: ${queued} waiting (concurrent calls serialize; limit ${app.queueLimit()})`);
		lines.push(backgroundStatusText());
		for (const q of background.pendingQuestions()) {
			lines.push(`pending question: ${q.runId} (${q.topic}) — answer with the delegate_answer tool`);
		}
		if (s.lastRun) {
			const dur = s.lastRun.durationMs != null ? `${Math.round(s.lastRun.durationMs / 1000)}s` : "";
			lines.push(`last run: ${s.lastRun.runId} ${s.lastRun.role} ${s.lastRun.state} ${dur}`.trimEnd());
		} else {
			lines.push("last run: none");
		}
		lines.push(`default role: ${s.defaultRole}`);
		lines.push(
			`base timeout: ${formatDuration(s.timeouts.hardMs)} hard · ${formatDuration(s.timeouts.inactivityMs)} idle ` +
			(s.timeouts.source === "project" ? `(project ${s.timeouts.projectPath})` : "(user-wide)"),
		);
		if (s.timeouts.projectCorrupt) {
			lines.push(`warning: project config corrupt, user values used: ${s.timeouts.projectCorrupt}`);
		}
		lines.push(`store: ${s.store.runsDir}`);
		if (app.getModeRuntime().persistenceDegraded) lines.push("warning: mode persistence is degraded");
		if (!s.modeEnabled) {
			const registered = pi.getAllTools().map((t: { name: string }) => t.name);
			if (!registered.includes("delegate")) lines.push("warning: delegate tool is not registered");
		}
		void ctx;
		return lines.join("\n");
	};

	const helpText = (): string =>
		[
			"/delegate                          dashboard (TUI) / status (headless)",
			"/delegate on | off                 strict delegation mode (session/branch scoped)",
			"/delegate status                   stable status text",
			"/delegate run general <task>       run a delegation with a role",
			"/delegate research <task>         research role",
			"/delegate bg [role] <task>        run it in the background (report arrives later)",
			"/delegate <task>                   general-role shorthand",
			"/delegate cancel [run-id]        cancel the active run",
			"/delegate answer <run-id> <text>   answer a blocked background child's question",
			"/delegate resume <run-id> <task> resume a prior run's child session",
			"/delegate inspect [run-id]       inspect a run (default: recent/active)",
			"/delegate paths                    config + run store paths",
			"/delegate doctor                 diagnostics",
			"/delegate help                   this help",
			"",
			"Background runs: delegate({ background: true, description: … }) spawns and returns",
			"immediately; the terminal report arrives as a message. Models poll the",
			"delegate_status tool; the dashboard shows live background runs.",
		].join("\n");

	const doctorText = (): string => {
		const report = app.doctor();
		const lines = [`[delegate doctor] ${report.ok ? "OK" : "ISSUES FOUND"}`];
		for (const c of report.checks) lines.push(`  ${c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"} ${c.name}: ${c.detail}`);
		return lines.join("\n");
	};

	const inspectText = (runId?: string): string => {
		try {
			const { metadata: m } = app.inspect(runId, false);
			const lines = [
				`[delegate inspect] ${m.runId}`,
				`state: ${m.state} · role: ${m.role} · source: ${m.source}`,
				`model: ${m.model}${m.thinkingLevel ? ` · thinking: ${m.thinkingLevel}` : ""}`,
				`created: ${m.createdAt}${m.startedAt ? ` · started: ${m.startedAt}` : ""}${m.finishedAt ? ` · finished: ${m.finishedAt}` : ""}`,
				m.exitCode != null ? `exit: ${m.exitCode}` : "",
				m.stopReason ? `stopReason: ${m.stopReason}` : "",
				m.errorCode ? `error: ${m.errorCode}: ${m.errorMessage ?? ""}` : "",
				`usage: in ${m.usage.input} / out ${m.usage.output} / cost ${m.usage.cost.toFixed(4)}${m.usage.turns ? ` / turns ${m.usage.turns}` : ""}`,
				`task: ${m.task.length > 120 ? `${m.task.slice(0, 117)}…` : m.task}`,
				`transcript: ${m.transcriptPath}`,
				`stderr: ${m.stderrPath}`,
			].filter(Boolean);
			if (m.finalHandoff) lines.push("", "final handoff (first 40 lines):", ...m.finalHandoff.split("\n").slice(0, 40));
			return lines.join("\n");
		} catch (error) {
			return `[delegate inspect] ${(error as Error).message}`;
		}
	};

	// ── 4. /delegate command ───────────────────────────────────────────────

	pi.registerCommand("delegate", {
		description: "Delegate tasks to isolated child Pi sessions; strict delegation mode gate.",
		getArgumentCompletions: (prefix: string) => {
			const items = delegateCompletions(prefix, app.recentRunIds(6)).map((v) => ({ value: v, label: v }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const intent: DelegateIntent = parseDelegateCommand(args ?? "");
			switch (intent.kind) {
				case "help":
					say(ctx, helpText());
					return;
				case "paths": {
					const p = app.paths();
					say(ctx, ["[delegate paths]", `config: ${p.configPath}`, `runs:   ${p.runsDir}`, `agent:  ${p.agentDir}`].join("\n"));
					return;
				}
				case "doctor":
					say(ctx, doctorText());
					return;
				case "status":
					say(ctx, statusText(ctx));
					return;
				case "enable": {
					const res = await app.enableStrict(modeCtx(ctx));
					say(ctx, `[delegate] ${res.message}`, res.ok ? "info" : "warning");
					return;
				}
				case "disable": {
					const res = await app.disableStrict(modeCtx(ctx));
					say(ctx, `[delegate] ${res.message}`, res.ok ? "info" : "warning");
					return;
				}
				case "cancel": {
					const res = await app.cancel(intent.runId);
					if (res.ok) {
						say(ctx, `[delegate] ${res.message}`);
						return;
					}
					// R8: background runs cancel by explicit runId (no foreground active).
					if (intent.runId && background.cancel(intent.runId)) {
						say(ctx, `[delegate] Cancellation requested for background run ${intent.runId}.`);
						return;
					}
					const live = background.liveRuns();
					if (live.length > 0) {
						say(ctx, `[delegate] No foreground run active. Live background runs: ${live.map((r) => r.runId).join(", ")} — cancel with /delegate cancel <run-id>.`, "warning");
						return;
					}
					say(ctx, `[delegate] ${res.message}`, "warning");
					return;
				}
				case "answer": {
					// R19: user intercept — answer a blocked child directly.
					const result = background.answer(intent.runId, intent.text, "user");
					if (result.ok) {
						say(ctx, `[delegate] Answer delivered to background run ${intent.runId}; the child is resuming.`);
					} else {
						say(ctx, `[delegate] ${result.error}`, "warning");
					}
					return;
				}
				case "inspect":
					say(ctx, inspectText(intent.runId));
					return;
				case "run":
					if (!isRoleName(intent.role)) {
						say(ctx, `[delegate] invalid role '${intent.role}'. Use general or research.`, "error");
						return;
					}
					await runCommandForeground(intent.task, intent.role, ctx, intent.timeoutMs);
					return;
				case "bg":
					await runCommandBackground(intent.task, isRoleName(intent.role) ? intent.role : "general", ctx, intent.timeoutMs);
					return;
				case "peek": {
					const id = intent.runId?.trim() || app.mostRecentRunId();
					if (!id) {
						say(ctx, "[delegate] no runs to peek at.", "warning");
						return;
					}
					await openPeek(ctx, id);
					return;
				}

				case "resume": {
					const runId = intent.runId?.trim();
					if (!runId || !intent.task) {
						say(ctx, `[delegate] usage: /delegate resume <run-id> <continuation task...>`, "error");
						return;
					}
					await runCommandForeground(intent.task, "general", ctx, intent.timeoutMs, { resumeFrom: runId });
					return;
				}
				case "invalid":
					say(ctx, `[delegate] unrecognized '${intent.token}'.\n${intent.usage}\n${helpText()}`, "error");
					return;
				case "dashboard":
				default:
					if (ctx.mode === "tui") {
						await openDashboard(ctx);
					} else {
						say(ctx, statusText(ctx));
					}
					return;
			}
		},
	});

	// ── Dashboard (§12.2) ───────────────────────────────────────────────────

	// ── 5b. Unified peek (shared by slash `peek` + dashboard `peek`) ────────

	const openPeek = async (ctx: ExtensionCommandContext, runId?: string): Promise<void> => {
		const id = runId?.trim() || app.mostRecentRunId();
		if (!id) {
			say(ctx, "[delegate] no runs to peek at.", "warning");
			return;
		}
		let meta;
		try {
			meta = app.inspect(id).metadata;
		} catch {
			say(ctx, `[delegate] unknown run '${id}'.`, "error");
			return;
		}
		if (!fsSync.existsSync(meta.transcriptPath)) {
			say(ctx, `[delegate] no transcript captured for ${id}.`, "warning");
			return;
		}
		if (ctx.mode === "tui") {
			await ctx.ui.custom<{ closed?: boolean } | undefined>((tui, theme, keybindings, done) => {
				const state = () => {
					let live = false;
					try {
						live = !["succeeded", "failed", "cancelled", "timed_out_idle", "timed_out_hard", "crashed"].includes(app.inspect(id).metadata.state);
					} catch {
						live = false;
					}
					const { startMs, events } = feedEventsFromTranscript(meta.transcriptPath, { maxEvents: 400 });
					return {
						title: `${id.slice(-16)} · ${meta.role}${meta.model ? ` · ${shortModel(meta.model)}` : ""} · ${meta.state}`,
						summary: meta.transcriptPath,
						lines: renderFeedEvents(events, { startMs: startMs || Date.now(), maxChars: 150 }),
						live,
					};
				};
				// Live-follow refresh timer; cleared the moment the overlay
				// closes (done wrapper) — never leaks past `q`/esc.
				let timer: ReturnType<typeof setInterval> | undefined;
				const wrappedDone = (result: { closed?: boolean }) => {
					if (timer) clearInterval(timer);
					done(result);
				};
				const view = new PeekView({ theme, keybindings, state, done: wrappedDone });
				timer = setInterval(() => tui.requestRender(), 1000);
				return view;
			}, {
				overlay: true,
				overlayOptions: { width: "92%", minWidth: 60, maxHeight: "80%", anchor: "center" },
			});
		} else {
			const { startMs, events } = feedEventsFromTranscript(meta.transcriptPath, { maxEvents: 400 });
			const lines = renderFeedEvents(events, { startMs: startMs || Date.now(), maxChars: 200 });
			say(ctx, `[delegate peek ${id} · ${meta.role} · ${meta.state}]\n${meta.transcriptPath}\n${lines.slice(-40).join("\n")}`);
		}
	};

	// ── 5c. Advanced configuration (secondary screen, opened from home) ──────

	const openAdvanced = async (ctx: ExtensionCommandContext, projectRoot: string): Promise<void> => {
		const buildRows = (): PanelRow[] => {
			const c = app.panelConfig();
			return [
				{ key: "cfg:user:queueLimit", label: "Queue limit", value: String(c.queueLimit), rawValue: String(c.queueLimit), kind: "input", inputHint: "concurrent calls that wait (1–10)" },
				{ key: "cfg:user:stuckToolTimeoutMs", label: "Stuck-tool watchdog", value: c.stuckToolTimeoutMs != null ? formatDuration(c.stuckToolTimeoutMs) : "hard (default)", rawValue: c.stuckToolTimeoutMs != null ? String(c.stuckToolTimeoutMs) : "", kind: "input", inputHint: "idle budget while a tool runs; leave hard blank to inherit" },
				{ key: "cfg:user:killGraceMs", label: "Kill grace", value: formatDuration(c.killGraceMs), rawValue: String(c.killGraceMs), kind: "input", inputHint: "SIGTERM→SIGKILL grace" },
				{ key: "cfg:user:handoffGraceMs", label: "Handoff grace", value: formatDuration(c.handoffGraceMs), rawValue: String(c.handoffGraceMs), kind: "input", inputHint: "wait for final handoff after a kill" },
				{ key: "cfg:user:handoffEnforceTimeoutMs", label: "Handoff enforce", value: formatDuration(c.handoffEnforceTimeoutMs), rawValue: String(c.handoffEnforceTimeoutMs), kind: "input", inputHint: "re-prompt until a schema handoff lands" },
				{ key: "cfg:user:maxTaskBytes", label: "Max task bytes", value: String(c.maxTaskBytes), rawValue: String(c.maxTaskBytes), kind: "input" },
				{ key: "cfg:user:maxResultBytes", label: "Max result bytes", value: String(c.maxResultBytes), rawValue: String(c.maxResultBytes), kind: "input" },
				{ key: "cfg:user:updateThrottleMs", label: "Update throttle", value: formatDuration(c.updateThrottleMs), rawValue: String(c.updateThrottleMs), kind: "input", inputHint: "live update cadence" },
				{ key: "info:defaultRole", label: "Default role", value: c.defaultRole, kind: "info" },
				{ key: "info:retention", label: "Retention", value: `${c.maxRuns} runs · ${c.maxRunAgeDays}d`, kind: "info" },
			];
		};
		try {
			await ctx.ui.custom(
				(tui, theme, keybindings, done) =>
					new SettingsPanel({
						theme,
						keybindings,
						initialKey: "cfg:user:queueLimit",
						snapshot: () => ({
							title: "Advanced configuration",
							summaryLines: ["User-wide · ~/.pi/agent/delegate/config.json", "Esc or any action returns to Delegation"],
							sections: [{ title: "Knobs", rows: buildRows() }],
						}),
						apply: (key: string, raw: string): string | null => {
							const m = /^cfg:user:([A-Za-z0-9]+)$/.exec(key);
							if (!m) return `Unknown setting '${key}'.`;
							return app.patchConfig(m[1]!, raw);
						},
						activate: (): PanelActionResult => ({ kind: "close", action: "advanced-done" }),
						requestRender: () => tui.requestRender(),
						done,
					}),
				{ onCancel: () => ({}) } as unknown as Record<string, never>,
			);
		} catch {
			/* esc → back to home */
		}
	};

	// ── 5d. Home dashboard snapshot (centralized live window) ───────────────

	const dashboardSnapshot = (projectRoot?: string): PanelSnapshot => {
		const s = app.getStatus(pi.getActiveTools(), projectRoot);
		const active = s.activeRun;
		const last = s.lastRun;
		const t = s.timeouts;
		const live = app.getActiveRunStream();
		const queued = app.queuedRunCount();

		const summaryLines: string[] = [];
		summaryLines.push(`Delegate v${delegateVersion()} · mode ${s.modeEnabled ? "strict (delegate-only)" : "normal"}`);
		if (active && live) {
			const phaseState = live.update.phase.startsWith("tool:") ? "running" : live.update.phase;
			const g = stateGlyph(phaseState);
			summaryLines.push(`Active   ${shortModel(live.update.model) || live.update.role} ${g.glyph} ${Math.round(live.update.elapsedMs / 1000)}s / ${formatDuration(live.hardMs)}`);
		} else if (active) {
			summaryLines.push(`Active   ${active.role} · ${active.runId.slice(-12)} · starting`);
		} else {
			summaryLines.push(`Idle     no active run`);
		}
		if (queued > 0) summaryLines.push(`Queue    ${queued} waiting (limit ${app.queueLimit()})`);
		if (last) {
			const g = stateGlyph(last.state);
			summaryLines.push(`Last     ${last.role} ${g.glyph} ${g.word}${last.durationMs != null ? ` in ${formatDuration(last.durationMs)}` : ""}`);
		}

		const sections: PanelSection[] = [];

		if (live) {
			const inflight = (live.update.openTools ?? []).slice(0, 3).join(", ");
			const frac = live.hardMs ? Math.min(1, live.update.elapsedMs / live.hardMs) : 0;
			const tail = renderFeedEvents([...live.events], { startMs: Date.now() - live.update.elapsedMs, maxChars: 96 }).slice(-3);
			const rows: PanelRow[] = [
				{ key: "live-phase", label: "Phase", value: `${live.update.phase}${live.update.model ? ` · ${shortModel(live.update.model)}` : ""}`, kind: "info", valueStyle: "accent" },
				{ key: "live-progress", label: "Progress", value: progressBar(frac, 24), kind: "info" },
				{ key: "live-tokens", label: "Tokens", value: `↑${formatTokens(live.update.usage?.input)} ↓${formatTokens(live.update.usage?.output)} · ${formatCost(live.update.usage?.cost)}`, kind: "info", valueStyle: "muted" },
				{ key: "live-inflight", label: "In flight", value: inflight || "—", kind: "info" },
			];
			tail.forEach((line, i) => rows.push({ key: `live-tail-${i}`, label: "", value: line, kind: "info", valueStyle: "muted" }));
			sections.push({ title: "Live", rows });
		}

		// R15: background runs section (live + recent terminal).
		{
			const bgLive = backgroundLiveViews();
			const bgRecent = app.backgroundRecentRuns(3);
			if (bgLive.length > 0 || bgRecent.length > 0) {
				const rows: PanelRow[] = [];
				for (const r of bgLive) {
					const g = r.phase ? stateGlyph(r.phase.startsWith("tool:") ? "running" : r.phase) : stateGlyph("starting");
					rows.push({
						key: `bg-${r.runId}`,
						label: `${g.glyph} ${r.role}`,
						value: `${r.description}${r.elapsedMs !== undefined ? ` · ${Math.round(r.elapsedMs / 1000)}s` : ""}${r.openTools?.length ? ` · ⏳ ${r.openTools.slice(0, 2).join(",")}` : ""}${r.detached ? " · branch inactive" : ""}`,
						kind: "info",
					});
				}
				for (const r of bgRecent) {
					const g = stateGlyph(r.state as never);
					rows.push({ key: `bg-last-${r.runId}`, label: `${g.glyph} last`, value: `${r.role} ${g.word}${r.durationMs != null ? ` · ${Math.round(r.durationMs / 1000)}s` : ""} · ${r.runId.slice(-12)}`, kind: "info", valueStyle: "muted" });
				}
				// R19: pending child questions are answerable from the panel.
				for (const q of background.pendingQuestions()) {
					rows.push({ key: `bg-answer-${q.runId}`, label: `? Answer ${q.runId.slice(-12)}`, value: `child blocked (${q.topic})`, kind: "action" });
				}
				rows.push({ key: "bg-slots", label: "Slots", value: `${bgLive.length}/${app.backgroundLimit()} active`, kind: "info", valueStyle: "muted" });
				sections.push({ title: "Background runs", rows });
			}
		}

		sections.push({
			title: "Actions",
			rows: [
				{ key: "run-general", label: "Run general task…", value: "", kind: "action" },
				{ key: "run-research", label: "Run research task…", value: "", kind: "action" },
				{ key: "run-background", label: "Run background task…", value: "", kind: "action" },
				{ key: "peek", label: "Peek live / final detail", value: "", kind: "action", disabled: !active && !last },
				{ key: "cancel", label: "Cancel active run", value: "", kind: "action", disabled: !active },
				{ key: "resume", label: "Resume last run…", value: "", kind: "action", disabled: !last },
				{ key: "strict-toggle", label: s.modeEnabled ? "Disable strict mode" : "Enable strict mode", value: "", kind: "action" },
				{ key: "configure-advanced", label: "Configure advanced…", value: "›", kind: "action" },
				{ key: "doctor", label: "Doctor", value: "", kind: "action" },
				{ key: "paths", label: "Paths", value: "", kind: "action" },
			],
		});

		sections.push({
			title: "Timeouts (base)",
			rows: [
				{ key: "cfg:user:hardTimeoutMs", label: "Hard · user-wide", value: formatDuration(t.userHardMs), rawValue: String(t.userHardMs), kind: "input", inputHint: "e.g. 30m / 2h / 1d — user config" },
				{ key: "cfg:user:inactivityTimeoutMs", label: "Idle · user-wide", value: formatDuration(t.userInactivityMs), rawValue: String(t.userInactivityMs), kind: "input", inputHint: "no-output watchdog; capped at ½ hard" },
				{ key: "cfg:project:hardTimeoutMs", label: "Hard · project", value: projectValueCell(t.projectHardMs, t.userHardMs), rawValue: t.projectHardMs !== undefined ? String(t.projectHardMs) : "", kind: "input", inputHint: `merges into ${t.projectPath ?? ".pi/delegate/config.json"}` },
				...(t.projectCorrupt
					? [{ key: "project-corrupt", label: "Project config", value: "corrupt — user values used", kind: "info" as const, valueStyle: "warning" as const }]
					: []),
			],
		});

		return {
			title: "Delegation",
			summaryLines,
			sections,
			shortcuts: [
				{ key: "r", label: "run", action: "run-general" },
				{ key: "p", label: "peek", action: "peek" },
				{ key: "x", label: "cancel", action: "cancel" },
				{ key: "c", label: "configure", action: "configure-advanced" },
				{ key: "d", label: "doctor", action: "doctor" },
				{ key: "s", label: "status", action: "status" },
			],
			detailLines: active
				? ["live refresh 1s · enter selects · peek / cancel in Actions"]
				: ["enter selects · edit a timeout, or run a task"],
		};
	};

	const openDashboard = async (ctx: ExtensionCommandContext): Promise<void> => {
		const projectRoot = ctx.cwd ?? process.cwd();
		let initialKey = app.isStrict() ? "run-general" : "run-general";
		for (;;) {
			let refreshTimer: ReturnType<typeof setInterval> | undefined;
			let result: { action?: string } | undefined;
			try {
				result = await ctx.ui.custom<{ action?: string }>(
					(tui, theme, keybindings, done) => {
						const panel = new SettingsPanel({
							theme,
							keybindings,
							initialKey,
							snapshot: () => dashboardSnapshot(projectRoot),
							apply: (key: string, raw: string): string | null => {
								const m = /^cfg:(user|project):([A-Za-z0-9]+)$/.exec(key);
								if (!m) return `Unknown setting '${key}'.`;
								const [, target, field] = m;
								return target === "project"
									? app.patchProjectConfig(projectRoot, field, raw)
									: app.patchConfig(field, raw);
							},
							activate: (key): PanelActionResult => ({ kind: "close", action: key }),
							requestRender: () => tui.requestRender(),
							done,
						});
						refreshTimer = setInterval(() => {
							panel.refresh();
							tui.requestRender();
						}, 1000);
						return panel;
					},
					{
						onCancel: () => ({ /* esc closes */ }),
					} as unknown as Record<string, never>,
				);
			} catch {
				return; // esc / cancel
			} finally {
				if (refreshTimer) clearInterval(refreshTimer);
			}
			const action = result?.action;
			if (!action) return;
			initialKey = action;
			if (action === "run-general" || action === "run-research") {
				const role = action === "run-research" ? ("research" as const) : ("general" as const);
				const task = await ctx.ui.editor(`Delegated task (${role})`, "");
				if (!task || !task.trim()) continue;
				await runCommandForeground(task, role, ctx);
				continue;
			}
			// R20: user-facing background launch — spawn, return immediately.
			if (action === "run-background") {
				const task = await ctx.ui.editor("Background task (returns immediately)", "");
				if (!task || !task.trim()) continue;
				await runCommandBackground(task.trim(), "general", ctx);
				continue;
			}
			if (action === "peek") {
				await openPeek(ctx);
				continue;
			}
			// R19: answer a pending child question from the panel.
			if (action.startsWith("bg-answer-")) {
				const qRunId = action.slice("bg-answer-".length);
				const answer = await ctx.ui.editor(`Answer child ${qRunId.slice(-12)}`, "");
				if (answer && answer.trim()) {
					const result = background.answer(qRunId, answer.trim(), "user");
					say(ctx, result.ok ? `[delegate] Answer delivered to background run ${qRunId}.` : `[delegate] ${result.error}`, result.ok ? "info" : "warning");
				}
				continue;
			}
			if (action === "cancel") {
				const ok = await ctx.ui.confirm("Cancel active run?", "SIGTERM then SIGKILL; a partial handoff is returned if the child produced one.");
				if (ok) {
					const res = await app.cancel();
					say(ctx, `[delegate] ${res.message}`, res.ok ? "info" : "warning");
				}
				continue;
			}
			if (action === "resume") {
				const target = app.getStatus(pi.getActiveTools(), projectRoot).lastRun;
				if (!target) {
					say(ctx, "[delegate] nothing to resume.", "warning");
					continue;
				}
				const task = await ctx.ui.editor(`Resume ${target.runId.slice(-12)} (${target.role})`, "");
				if (!task || !task.trim()) continue;
				await runCommandForeground(task, target.role === "research" ? "research" : "general", ctx, undefined, { resumeFrom: target.runId });
				continue;
			}
			if (action === "strict-toggle") {
				const res = app.isStrict() ? await app.disableStrict(modeCtx(ctx)) : await app.enableStrict(modeCtx(ctx));
				say(ctx, `[delegate] ${res.message}`, res.ok ? "info" : "warning");
				continue;
			}
			if (action === "configure-advanced") {
				await openAdvanced(ctx, projectRoot);
				continue;
			}
			if (action === "doctor") {
				say(ctx, doctorText());
				continue;
			}
			if (action === "status") {
				say(ctx, statusText(ctx));
				continue;
			}
			if (action === "paths") {
				const p = app.paths();
				say(ctx, [`[delegate paths]`, `config: ${p.configPath}`, `runs:   ${p.runsDir}`].join("\n"));
				continue;
			}
			if (action === "inspect-last") {
				say(ctx, inspectText());
				continue;
			}
			return;
		}
	};

	// ── 6. Strict tool_call gate — authoritative allowlist ──────────────────

	pi.on("tool_call", async (event: { toolName: string }) => {
		const decision = app.gate(event.toolName);
		if (decision.block) return { block: true, reason: decision.reason };
		return undefined;
	});

	// ── 7. Lifecycle ────────────────────────────────────────────────────────

	const hydrateFromSession = (ctx: ExtensionContext): SessionEntryLike[] => {
		let branch: SessionEntryLike[] = [];
		try {
			branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
			app.hydrateFromBranch(branch);
		} catch (error) {
			// Replay failure keeps the stricter of both states (§8.2).
			console.log(`[delegate] mode replay failed: ${(error as Error).message}`);
		}
		if (app.isStrict()) {
			ctx.ui.setStatus("delegate", "delegate: strict");
			footerUi = ctx.ui;
			refreshFooter();
			// Repair visibility immediately in case the session had drifted.
			try {
				syncStrictToolSet(app.getModeRuntime(), pi.getActiveTools(), () => pi.setActiveTools(STRICT_ACTIVE_TOOLS));
			} catch {
				// gate remains authoritative
			}
		}
		footerUi = ctx.ui;
		refreshFooter();
		refreshDoctor(ctx);
		return branch;
	};

	pi.on("session_start", async (_event, ctx) => {
		hydrateFromSession(ctx);
		// R12/R13: adopt the branch; deliver undelivered terminals once.
		try {
			const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
			const { resent, notes } = background.start(branch);
			if (resent.length > 0 || notes.length > 0) {
				console.log(`[delegate] background reconcile: ${resent.length} resent${notes.length ? `; ${notes.join("; ")}` : ""}`);
			}
		} catch (error) {
			console.log(`[delegate] background reconcile failed: ${(error as Error).message}`);
		}
		if ((unknownKeys.length > 0 || recoveredFromCorrupt) && ctx.hasUI) {
			const parts: string[] = [];
			if (unknownKeys.length > 0) parts.push(`unknown config keys ignored: ${unknownKeys.join(", ")}`);
			if (recoveredFromCorrupt) parts.push(`corrupt config preserved at ${corruptEvidencePath ?? "?"}`);
			ctx.ui.notify(`delegate: ${parts.join("; ")}`, "warning");
		}
	});

	pi.on("session_before_tree", async () => {
		// R13: no background delivery while a tree switch is in flight.
		background.beforeTree();
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Branch navigation: mode follows the new leaf (§8.2, E2E-03).
		hydrateFromSession(ctx);
		// R12/R13: re-adopt the new branch, resume buffered delivery.
		try {
			const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
			const { resent, notes } = background.afterTree(branch);
			if (resent.length > 0 || notes.length > 0) {
				console.log(`[delegate] background re-adopt: ${resent.length} resent${notes.length ? `; ${notes.join("; ")}` : ""}`);
			}
		} catch (error) {
			console.log(`[delegate] background re-adopt failed: ${(error as Error).message}`);
		}
	});

	pi.on("before_agent_start", async (event: { systemPrompt?: string }, ctx) => {
		if (!app.isStrict()) return undefined;
		// Drift repair before provider call; keep advertised set to ['delegate'].
		try {
			syncStrictToolSet(app.getModeRuntime(), pi.getActiveTools(), () => pi.setActiveTools(["delegate"]));
		} catch {
			// gate remains authoritative
		}
		resetBlockedCounters(app.getModeRuntime());
		const prompt = event.systemPrompt ?? "";
		if (prompt.includes("[DELEGATION-MODE OVERLAY")) return undefined;
		return { systemPrompt: `${prompt}\n\n${STRICT_OVERLAY}` };
	});

	pi.on("turn_start", async () => {
		resetBlockedCounters(app.getModeRuntime());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Owned children get cancelled; UI indicators cleared.
		app.cancelActiveOnShutdown();
		background.shutdown();
		try {
			ctx.ui.setStatus("delegate", undefined);
		} catch {
			// ignore
		}
	});
}
