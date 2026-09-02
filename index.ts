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

import { loadConfig, parseDuration, saveConfig } from "./config.ts";
import { parseDelegateCommand, delegateCompletions, type DelegateIntent } from "./commands.ts";
import { DELEGATE_ROLES, isRoleName, resolveRole } from "./roles.ts";
import { STRICT_OVERLAY, syncStrictToolSet, resetBlockedCounters } from "./mode.ts";
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
import { SettingsPanel, type PanelSnapshot, type PanelActionResult } from "./ui/settings-panel.ts";
import { RunningView, type RunningViewState } from "./ui/running-view.ts";

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

export default function delegateExtension(pi: ExtensionAPI) {
	// 1. The child never reactivates this extension (POL: no recursion).
	if (process.env.PI_DELEGATE_CHILD === "1") return;
	// 2. Construct state — no child, no timers at load time.
	// PI_DELEGATE_AGENT_DIR is a test override; production uses getAgentDir().
	const agentDir = process.env.PI_DELEGATE_AGENT_DIR || getAgentDir();
	const { config, unknownKeys, recoveredFromCorrupt, corruptEvidencePath } = loadConfig(agentDir);
	const app = new DelegateApplicationImpl({ agentDir, config });
	// Startup orphan recovery (§10.6): receipts only; never kills PIDs.
	app.markOrphansOnStartup();

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
		const head = `[delegate ${d.runId} · ${d.role} · ${stateLabel} in ${secs}s]`;
		if (!res.ok) {
			const err = res.error ? `${res.error.code}: ${res.error.message}` : "unknown failure";
			return `${head}\nerror: ${err}\ntranscript: ${d.transcriptPath}`;
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
				"Use it when the subtask is expected to run longer than the configured default; it overrides the project/user config base.",
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
			const request = buildRequest(params.task, params.role ?? config.defaultRole, "tool", ctx, timeoutMs);
			refreshDoctor(ctx);
			const hooks = {
				abortSignal: signal ?? undefined,
				onUpdate: (u: RunStreamUpdate) => {
					onUpdate?.({
						content: [{ type: "text", text: `[delegate ${u.runId} · ${u.role} · ${u.phase} · ${Math.round(u.elapsedMs / 1000)}s]` }],
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
			const text = `delegate(${role}): ${task.length > 70 ? `${task.slice(0, 67)}…` : task}`;
			return new Text(theme?.fg ? theme.fg("accent", text) : text, 0, 0);
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		renderResult(result: any, options: any, theme: any) {
			const d = result.details as DelegateDetails | undefined;
			if (!d?.runId) {
				const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").filter(Boolean).join("\n");
				return new Text(text || "(no output)", 0, 0);
			}
			const fg = (kind: string, s: string) => (theme?.fg ? theme.fg(kind, s) : s);
			const u = d.usage ?? {};
			const bits: string[] = [`${d.role ?? "?"} · ${d.state ?? "?"}`];
			if (u.input) bits.push(`↑${u.input}`);
			if (u.output) bits.push(`↓${u.output}`);
			if (u.cost) bits.push(`$${u.cost.toFixed(4)}`);
			const header = `→ ${d.runId}`;
			if (!options?.expanded) {
				const body = bits.join(" ") + (d.outputTruncated && d.transcriptPath ? `\ntranscript: ${d.transcriptPath}` : "");
				return new Text(`${fg("accent", header)}\n${body}`, 0, 0);
			}
			// Expanded: compact summary — Outcome + key lines + last actions.
			const res = result as unknown as DelegateRunResult;
			const summary = formatRunSummary(res);
			const stateColor = d.state === "succeeded" ? "success" : d.state === "cancelled" ? "muted" : "warning";
			const body = bits.join(" ") + (summary ? `\n${summary}` : "");
			return new Text(`${fg("accent", header)}\n${fg(stateColor, body)}`, 0, 0);
		},
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

	const runCommandForeground = async (task: string, role: "general" | "research", ctx: ExtensionCommandContext, timeoutMs?: number): Promise<void> => {
		const request = buildRequest(task, role, "command", ctx, timeoutMs);
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
				lastActions: [],
			};
			const runPromise = app.run(request, {
				...hooks,
				onUpdate: (u: RunStreamUpdate) => {
					hooks.onUpdate?.(u);
					viewState.runId = u.runId;
					viewState.role = u.role;
					viewState.phase = u.phase;
					viewState.elapsedMs = u.elapsedMs;
					viewState.lastActions = u.lastActions;
				},
			});
			const outcome = await ctx.ui.custom<{ cancelled?: boolean } | undefined>(
				(tui, theme, keybindings, done) =>
					new RunningView({
						theme,
						keybindings,
						state: () => viewState,
						done,
					}),
			);
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

	const statusText = (ctx: ExtensionContext): string => {
		const s = app.getStatus(pi.getActiveTools());
		const lines = ["[delegate]", `mode: ${s.modeEnabled ? "strict" : "normal"}`];
		lines.push(`parent tools: ${s.modeEnabled ? "delegate only" : "normal active set"}`);
		lines.push(`active run: ${s.activeRun ? `${s.activeRun.runId} (${s.activeRun.role})` : "none"}`);
		if (s.lastRun) {
			const dur = s.lastRun.durationMs != null ? `${Math.round(s.lastRun.durationMs / 1000)}s` : "";
			lines.push(`last run: ${s.lastRun.runId} ${s.lastRun.role} ${s.lastRun.state} ${dur}`.trimEnd());
		} else {
			lines.push("last run: none");
		}
		lines.push(`default role: ${s.defaultRole}`);
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
			"/delegate <task>                   general-role shorthand",
			"/delegate cancel [run-id]        cancel the active run",
			"/delegate inspect [run-id]       inspect a run (default: recent/active)",
			"/delegate paths                    config + run store paths",
			"/delegate doctor                 diagnostics",
			"/delegate help                   this help",
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
					say(ctx, `[delegate] ${res.message}`, res.ok ? "info" : "warning");
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

	const dashboardSnapshot = (): PanelSnapshot => {
		const s = app.getStatus(pi.getActiveTools());
		const active = s.activeRun;
		const last = s.lastRun;
		return {
			title: "Delegation",
			summaryLines: [
				`Parent mode      ${s.modeEnabled ? "strict" : "normal"}`,
				`Parent tools     ${s.modeEnabled ? "delegate only" : "normal active set"}`,
				`Active run       ${active ? `${active.runId.slice(0, 24)} (${active.role})` : "none"}`,
				`Last run         ${last ? `${last.role} · ${last.state}${last.durationMs != null ? ` · ${Math.round(last.durationMs / 1000)}s` : ""}` : "none"}`,
				`Default role     ${s.defaultRole}`,
			],
			sections: [
				{
					title: "Actions",
					rows: [
						{ key: "run-general", label: "Run general", value: "", kind: "action" },
						{ key: "run-research", label: "Run research", value: "", kind: "action" },
						{ key: "strict-toggle", label: s.modeEnabled ? "Disable strict mode" : "Enable strict mode", value: "", kind: "action" },
						{ key: "inspect-last", label: "Inspect last run", value: "", kind: "action", disabled: !last && !active },
						{ key: "paths", label: "Paths / diagnostics", value: "", kind: "action" },
						{ key: "doctor", label: "Doctor", value: "", kind: "action" },
					],
				},
			],
			detailLines: active ? [`elapsed updates refresh every 1s while a run is active`] : undefined,
		};
	};

	const openDashboard = async (ctx: ExtensionCommandContext): Promise<void> => {
		let initialKey = app.isStrict() ? "strict-toggle" : "run-general";
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
							snapshot: dashboardSnapshot,
							apply: () => null,
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
			if (action === "strict-toggle") {
				if (app.isStrict()) {
					const res = await app.disableStrict(modeCtx(ctx));
					say(ctx, `[delegate] ${res.message}`, res.ok ? "info" : "warning");
				} else {
					const res = await app.enableStrict(modeCtx(ctx));
					say(ctx, `[delegate] ${res.message}`, res.ok ? "info" : "warning");
				}
				continue;
			}
			if (action === "inspect-last") {
				say(ctx, inspectText());
				continue;
			}
			if (action === "paths") {
				const p = app.paths();
				say(ctx, [`[delegate paths]`, `config: ${p.configPath}`, `runs:   ${p.runsDir}`].join("\n"));
				continue;
			}
			if (action === "doctor") {
				say(ctx, doctorText());
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

	const hydrateFromSession = (ctx: ExtensionContext) => {
		try {
			const branch = ctx.sessionManager.getBranch() as SessionEntryLike[];
			app.hydrateFromBranch(branch);
		} catch (error) {
			// Replay failure keeps the stricter of both states (§8.2).
			console.log(`[delegate] mode replay failed: ${(error as Error).message}`);
		}
		if (app.isStrict()) {
			ctx.ui.setStatus("delegate", "delegate: strict");
			// Repair visibility immediately in case the session had drifted.
			try {
				syncStrictToolSet(app.getModeRuntime(), pi.getActiveTools(), () => pi.setActiveTools(["delegate"]));
			} catch {
				// gate remains authoritative
			}
		}
		refreshDoctor(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		hydrateFromSession(ctx);
		if ((unknownKeys.length > 0 || recoveredFromCorrupt) && ctx.hasUI) {
			const parts: string[] = [];
			if (unknownKeys.length > 0) parts.push(`unknown config keys ignored: ${unknownKeys.join(", ")}`);
			if (recoveredFromCorrupt) parts.push(`corrupt config preserved at ${corruptEvidencePath ?? "?"}`);
			ctx.ui.notify(`delegate: ${parts.join("; ")}`, "warning");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Branch navigation: mode follows the new leaf (§8.2, E2E-03).
		hydrateFromSession(ctx);
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
		// Owned child gets cancelled; UI indicators cleared.
		app.cancelActiveOnShutdown();
		try {
			ctx.ui.setStatus("delegate", undefined);
		} catch {
			// ignore
		}
	});
}
