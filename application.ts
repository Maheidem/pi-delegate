/**
 * delegate — canonical application core (Pi-free).
 *
 * Tool and command paths MUST route through application.run(); neither
 * constructs child arguments independently (§11). The application owns the
 * single active-run reservation (FR-007/POL-005), role/trust/model
 * validation, store access, runner lifecycle, retention, and diagnostics.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	CancelResult,
	DelegateApplication,
	DelegateApplicationPorts,
	DelegateDetails,
	DelegateErrorCode,
	DelegatePaths,
	DelegateRequest,
	DelegateRunResult,
	DelegateStatus,
	DoctorCheck,
	DoctorReport,
	ModeResult,
	ModeRuntime,
	ModeTransitionContext,
	RoleName,
	RunAttemptResult,
	RunHooks,
	RunInspection,
	RunMetadataV1,
	RunnerOutcome,
	RunStreamUpdate,
	TranscriptRecordV1,
	SessionEntryLike,
} from "./types.ts";
import { FeedRing, type FeedEvent } from "./transcript-feed.ts";
import { decodeTranscriptRecord } from "./types.ts";
import { applyProjectOverlay, clampConfigField, formatDuration, normalizeConfig, parseDuration, projectConfigPath, resolveRunTimeouts, saveConfig, saveProjectConfig, type DelegateConfigV1 } from "./config.ts";
import { EMPTY_USAGE } from "./types.ts";
import { isRoleName, resolveRole, rolePromptExists, DELEGATE_ROLES } from "./roles.ts";
import {
	replayModeEntries,
	applyReplayToRuntime,
	newModeRuntime,
	enableStrict as modeEnableStrict,
	disableStrict as modeDisableStrict,
	gateToolCall,
} from "./mode.ts";
import {
	openRun,
	listRuns,
	readRunMetadata,
	markOrphanedRuns,
	enforceRetention,
	runPaths,
	pathsForAgentDir,
} from "./run-store.ts";
import { DelegateRunner, resolvePiInvocation, type PiInvocationResolver } from "./runner.ts";
import { validateTask } from "./commands.ts";

interface ActiveRunReservation {
	id: string;
	role: RoleName;
	runner: DelegateRunner;
	startedAt: string;
	/** Effective hard cap for the live progress bar (§ S2). */
	hardMs: number;
}

/**
 * A concurrent delegate call waiting for the single child slot. Pi executes
 * parallel tool calls truly in parallel and models routinely fan out — the
 * queue serializes those calls on the one-child policy instead of failing
 * them: a 4-way fan-out becomes 4 back-to-back children and 4 real results.
 */
interface QueuedRun {
	request: DelegateRequest;
	hooks: RunHooks;
	resolve: (result: RunAttemptResult) => void;
}

function errorResult(
	runId: string,
	role: RoleName,
	code: DelegateErrorCode,
	message: string,
	extra?: Partial<DelegateDetails>,
): DelegateRunResult {
	const now = new Date().toISOString();
	return {
		ok: false,
		handoff: "",
		details: {
			schemaVersion: 1,
			runId,
			role,
			state: "failed",
			startedAt: now,
			finishedAt: now,
			durationMs: 0,
			model: "",
			usage: { ...EMPTY_USAGE },
			outputBytes: 0,
			outputTruncated: false,
			transcriptPath: "",
			stderrPath: "",
			displayItems: [],
			...extra,
		},
		error: { code, message },
	};
}

export class DelegateApplicationImpl implements DelegateApplication {
	private activeRun: ActiveRunReservation | null = null;
	/** Live state of the active run, captured for the home dashboard (§ S2). */
	private activeStream: RunStreamUpdate | null = null;
	private activeRing: FeedRing = new FeedRing(120);
	private runQueue: QueuedRun[] = [];
	private readonly modeRuntime: ModeRuntime;
	private readonly ports: DelegateApplicationPorts;
	private liveConfig: DelegateConfigV1;

	constructor(ports: DelegateApplicationPorts) {
		this.ports = ports;
		this.liveConfig = ports.config;
		this.modeRuntime = newModeRuntime();
	}

	/**
	 * Live-edit one numeric config knob with validation + atomic persistence
	 * (dashboard edits). Returns an error string or null.
	 */
	patchConfig(key: string, rawValue: string): string | null {
		const current = this.liveConfig as unknown as Record<string, unknown>;
		if (!(key in current)) return `Unknown setting '${key}'.`;
		const num = parseSettingValue(rawValue);
		if (num === null) return settingParseError(rawValue);
		try {
			const { config } = normalizeConfig({ ...current, [key]: num });
			saveConfig(this.ports.agentDir, config);
			this.liveConfig = config;
			return null;
		} catch (error) {
			return `Save failed: ${(error as Error).message}`;
		}
	}

	/**
	 * Live-edit one numeric knob of the PROJECT overlay file
	 * (`<root>/.pi/delegate/config.json`): merged in, only the given key
	 * changes, clamped by the same bounds as the user config.
	 */
	patchProjectConfig(projectRoot: string, key: string, rawValue: string): string | null {
		if (!projectRoot) return "No project root available.";
		const num = parseSettingValue(rawValue);
		if (num === null) return settingParseError(rawValue);
		const clamped = clampConfigField(key, num);
		if (clamped === null) return `Unknown setting '${key}'.`;
		try {
			saveProjectConfig(projectRoot, { [key]: clamped } as Partial<DelegateConfigV1>);
			return null;
		} catch (error) {
			return `Save failed: ${(error as Error).message}`;
		}
	}

	// ── Mode ───────────────────────────────────────────────────────────────

	isStrict(): boolean {
		return this.modeRuntime.hydrated && this.modeRuntime.modeEnabled;
	}

	getModeRuntime(): ModeRuntime {
		return this.modeRuntime;
	}

	/** Hydrate mode from a session branch replay (called by the adapter). */
	hydrateFromBranch(branch: SessionEntryLike[]): void {
		const replay = replayModeEntries(branch);
		applyReplayToRuntime(this.modeRuntime, replay);
	}

	async enableStrict(ctx: ModeTransitionContext): Promise<ModeResult> {
		return modeEnableStrict(this.modeRuntime, ctx);
	}

	async disableStrict(ctx: ModeTransitionContext): Promise<ModeResult> {
		return modeDisableStrict(this.modeRuntime, ctx);
	}

	/** Strict tool_call gate decision (allowlist; fail-closed). */
	gate(toolName: unknown): { block: boolean; reason?: string } {
		return gateToolCall(this.modeRuntime, toolName);
	}

	// ── Run ────────────────────────────────────────────────────────────────

	getActiveRun(): { runId: string; role: RoleName; startedAt: string } | null {
		if (!this.activeRun) return null;
		return { runId: this.activeRun.id, role: this.activeRun.role, startedAt: this.activeRun.startedAt };
	}

	/** Live state of the active run (identity update + feed events + queue),
	 * for the home dashboard's Live block. Null when nothing is running. */
	getActiveRunStream(): { update: RunStreamUpdate; events: readonly FeedEvent[]; queue: number; hardMs: number } | null {
		if (!this.activeRun || !this.activeStream) return null;
		return { update: this.activeStream, events: this.activeRing.all(), queue: this.runQueue.length, hardMs: this.activeRun.hardMs };
	}

	/** Advanced knobs for the dashboard's Configure-advanced screen (§ S7). */
	panelConfig(): Pick<DelegateConfigV1, "queueLimit" | "killGraceMs" | "handoffGraceMs" | "handoffEnforceTimeoutMs" | "stuckToolTimeoutMs" | "maxTaskBytes" | "maxResultBytes" | "updateThrottleMs" | "defaultRole" | "maxRuns" | "maxRunAgeDays"> {
		const c = this.liveConfig;
		return {
			queueLimit: c.queueLimit,
			killGraceMs: c.killGraceMs,
			handoffGraceMs: c.handoffGraceMs,
			handoffEnforceTimeoutMs: c.handoffEnforceTimeoutMs,
			stuckToolTimeoutMs: c.stuckToolTimeoutMs,
			maxTaskBytes: c.maxTaskBytes,
			maxResultBytes: c.maxResultBytes,
			updateThrottleMs: c.updateThrottleMs,
			defaultRole: c.defaultRole,
			maxRuns: c.maxRuns,
			maxRunAgeDays: c.maxRunAgeDays,
		};
	}

	/**
	 * Canonical entry point shared by tool and command. ONE child executes at
	 * a time (POL-005): concurrent calls queue (bounded by `queueLimit`) and
	 * run back-to-back — models fan out, and the queue turns that into
	 * serialized results instead of an error storm.
	 */
	async run(request: DelegateRequest, hooks: RunHooks = {}): Promise<RunAttemptResult> {
		if (this.activeRun) {
			if (this.runQueue.length >= this.liveConfig.queueLimit) {
				return {
					ok: false,
					busy: true,
					runId: this.activeRun.id,
					role: this.activeRun.role,
					message: `Delegation queue is full (${this.runQueue.length} waiting) while run ${this.activeRun.id} (${this.activeRun.role}) executes.`,
					error: {
						code: "E_DELEGATE_BUSY",
						message: `Queue full (${this.runQueue.length} waiting; limit ${this.liveConfig.queueLimit}); active run ${this.activeRun.id} (${this.activeRun.role}). Wait for the in-flight results, then re-issue.`,
					},
				};
			}
			return await new Promise<RunAttemptResult>((resolve) => {
				const entry: QueuedRun = { request, hooks, resolve };
				// Aborting a STILL-QUEUED call removes it (the runner wires
				// the signal only once spawned); once started, the runner
				// owns cancellation through the same signal.
				const onAbort = () => {
					const idx = this.runQueue.indexOf(entry);
					if (idx >= 0) {
						this.runQueue.splice(idx, 1);
						resolve(
							errorResult("", request.role, "E_CANCELLED", "aborted before start (queued call cancelled)", {
								state: "cancelled",
							}),
						);
					}
				};
				if (hooks.abortSignal) {
					if (hooks.abortSignal.aborted) {
						onAbort();
						return;
					}
					hooks.abortSignal.addEventListener("abort", onAbort, { once: true });
				}
				this.runQueue.push(entry);
			});
		}
		return await this.startRun(request, hooks);
	}

	/** Execute one run in the free slot (reservation stays synchronous). */
	private async startRun(request: DelegateRequest, hooks: RunHooks = {}): Promise<RunAttemptResult> {

		const agentDir = this.ports.agentDir;
		// Config cascade: project .pi/delegate/config.json overlays the
		// user-wide (live) config per run; missing file = live config.
		let baseCfg: DelegateConfigV1 = this.liveConfig;
		let projectSetsHard = false;
		if (request.projectRoot) {
			// Strip the overlay's diagnostic keys so only real config fields
			// reach the runner (a spurious key would survive into metadata).
			const overlay = applyProjectOverlay(this.liveConfig, request.projectRoot);
			const { projectOverrides, projectCorrupt, ...rest } = overlay as unknown as DelegateConfigV1 & {
				projectOverrides: string[];
				projectCorrupt?: string;
			};
			projectSetsHard = projectOverrides.includes("hardTimeoutMs");
			baseCfg = { ...(rest as unknown as DelegateConfigV1) } as DelegateConfigV1;
		}

		// Timeout resolution: per-invocation > project > user (baseCfg carries
		// the project overlay). Inactivity is capped at half of hard for ANY
		// source, so a long-silent child can never outlive its watchdog. A
		// per-run copy so overrides never leak into later runs.
		const timeouts = resolveRunTimeouts(baseCfg, request.timeoutMs);
		const cfg: DelegateConfigV1 = {
			...baseCfg,
			hardTimeoutMs: timeouts.hardMs,
			inactivityTimeoutMs: timeouts.inactivityMs,
			stuckToolTimeoutMs: timeouts.stuckToolMs,
		};
		// R7: timeout provenance for the result header, e.g.
		// "hard 45m (per-run) · idle 22m30s · stuck-tool 45m".
		const timeoutInfo =
			`hard ${formatDuration(timeouts.hardMs)} (${request.timeoutMs !== undefined ? "per-run" : projectSetsHard ? "project" : "user"})` +
			` · idle ${formatDuration(timeouts.inactivityMs)}` +
			` · stuck-tool ${formatDuration(timeouts.stuckToolMs)}`;

		// 2. Validate task (line endings, blank, byte limit).
		const taskResult = validateTask(request.task, cfg.maxTaskBytes);
		if (typeof taskResult !== "string") {
			return errorResult("", isRoleName(request.role) ? request.role : "general", "E_INVALID_TASK", `Task invalid: ${taskResult.error}`);
		}
		const task = taskResult;

		// 3. Role (closed catalogue).
		if (!isRoleName(request.role)) {
			return errorResult("", "general", "E_INVALID_ROLE", `Unknown role '${String(request.role)}'. Use 'general' or 'research'.`);
		}
		const role = resolveRole(request.role, cfg.defaultRole);

		// 4. Project trust for the write-capable general role.
		if (role.name === "general" && !request.projectTrusted) {
			return errorResult("", role.name, "E_PROJECT_UNTRUSTED", "Project is not trusted; a write-capable child cannot run. Approve trust or use the research role.");
		}

		// 5. Model resolution (R5): an explicit `model` pin wins; otherwise
		// the parent's current model is inherited as before.
		const model = request.model?.trim() || request.parentModel?.trim();
		if (!model) {
			return errorResult("", role.name, "E_MODEL_UNAVAILABLE", "No parent model available to inherit. Select or configure a model, or pass an explicit child model.");
		}
		const modelNote = request.model?.trim() && request.model!.trim() !== request.parentModel?.trim()
			? `child model pinned to ${request.model!.trim()} (parent model ${request.parentModel || "none"} not inherited)`
			: undefined;

		// R3: resume — re-enter a prior run's durable child session.
		let resumeOf: string | undefined;
		let sessionPath: string | undefined;
		if (request.resumeFrom) {
			const prior = readRunMetadata(agentDir, request.resumeFrom);
			if (!prior) {
				return errorResult("", role.name, "E_STORE", `resumeFrom: no receipt for run ${request.resumeFrom}.`);
			}
			if (!prior.sessionPath || !fs.existsSync(prior.sessionPath)) {
				return errorResult("", role.name, "E_STORE", `resumeFrom: run ${request.resumeFrom} has no durable child session on disk (pre-0.2.0 runs are not resumable).`);
			}
			resumeOf = prior.runId;
			sessionPath = prior.sessionPath;
		}

		// 6. Role prompt readability.
		if (!rolePromptExists(role)) {
			return errorResult("", role.name, "E_STORE", `Role prompt asset is unreadable for role '${role.name}'.`);
		}

		// 7. Open run store entry (atomic, 0700/0600).
		let opened;
		try {
			opened = openRun(agentDir, { ...request, task, role: role.name });
		} catch (error) {
			return errorResult("", role.name, "E_STORE", `Run store could not initialize: ${(error as Error).message}`);
		}

		// R3: durable session storage for new runs (resumed runs re-enter
		// the prior session file directly).
		const sessionDir = sessionPath ? undefined : path.join(opened.paths.runsDir, "sessions");
		if (sessionDir) {
			try {
				fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
			} catch {
				// session capture is best-effort; the run still proceeds
			}
		}

		// 8. Reservation NOW covers the child lifecycle.
		// Capture live state for the home dashboard while forwarding the caller's hooks.
		this.activeStream = null;
		this.activeRing = new FeedRing(120);
		const captureHooks: RunHooks = {
			...hooks,
			onUpdate: (u: RunStreamUpdate) => {
				this.activeStream = u;
				hooks.onUpdate?.(u);
			},
			onEvent: (e: FeedEvent) => {
				this.activeRing.push(e);
				hooks.onEvent?.(e);
			},
		};
		const runner = new DelegateRunner(
			opened,
			{
				agentDir,
				role,
				task,
				runId: opened.metadata.runId,
				parentModel: model,
				thinkingLevel: request.thinkingLevel,
				cwd: request.cwd,
				projectTrusted: request.projectTrusted,
				registeredTools: this.lastRegisteredTools,
				...(resumeOf ? { resumeOf } : {}),
				...(sessionPath ? { sessionPath } : {}),
				...(sessionDir ? { sessionDir } : {}),
			},
			cfg,
			captureHooks,
			this.ports.resolveInvocation ?? resolvePiInvocation,
		);
		const reservation: ActiveRunReservation = {
			id: opened.metadata.runId,
			role: role.name,
			runner,
			startedAt: opened.metadata.createdAt,
			hardMs: timeouts.hardMs,
		};
		this.activeRun = reservation;

		try {
			const outcome = await runner.run();
			this.activeRun = null;
			// Retention after terminal finalization (best-effort).
			try {
				enforceRetention(agentDir, cfg.maxRuns, cfg.maxRunAgeDays, undefined);
			} catch {
				// cleanup failure is warning-only
			}
			return outcomeToRunResult(outcome, opened.metadata, role.name, model, request.thinkingLevel, { timeoutInfo, modelNote });
		} catch (error) {
			this.activeRun = null;
			return errorResult(opened.metadata.runId, role.name, "E_CHILD_EXIT", `Delegation failed unexpectedly: ${(error as Error).message}`);
		} finally {
			this.startNextQueuedRun();
		}
	}

	/** Queued-call introspection for status views. */
	queuedRunCount(): number {
		return this.runQueue.length;
	}

	queueLimit(): number {
		return this.liveConfig.queueLimit;
	}

	/** Pop the next queued run (if any) into the free slot, fire-and-forget. */
	private startNextQueuedRun(): void {
		const next = this.runQueue.shift();
		if (!next) return;
		void this.startRun(next.request, next.hooks).then(next.resolve, (error: unknown) => {
			next.resolve(errorResult("", next.request.role, "E_CHILD_EXIT", `Delegation failed unexpectedly: ${(error as Error).message}`));
		});
	}

	/** Cancel the active run (default) or an exact run ID. */
	async cancel(runId?: string): Promise<CancelResult> {
		const active = this.activeRun;
		if (!active) {
			return { ok: false, message: "No active delegation to cancel.", error: { code: "E_DELEGATE_BUSY", message: "No active run." } };
		}
		if (runId && runId !== active.id) {
			return {
				ok: false,
				runId,
				message: `Run ${runId} is not the active run (active: ${active.id}). Only the active run can be cancelled.`,
				error: { code: "E_DELEGATE_BUSY", message: "Unrelated run ID; cancel applies to the active run only." },
			};
		}
		active.runner.cancel("cancelled");
		return { ok: true, runId: active.id, message: `Cancellation requested for ${active.id}.` };
	}

	/** Cancel the active run on shutdown paths (session_shutdown). */
	cancelActiveOnShutdown(): void {
		this.activeRun?.runner.cancel("cancelled");
	}

	// ── Inspection ─────────────────────────────────────────────────────────

	inspect(runId?: string, includeTranscript = false): RunInspection {
		const agentDir = this.ports.agentDir;
		const id = runId ?? this.mostRecentRunId();
		if (!id) throw Object.assign(new Error("No delegation runs exist."), { code: "E_RUN_NOT_FOUND" });
		const metadata = readRunMetadata(agentDir, id);
		if (!metadata) throw Object.assign(new Error(`Unknown run id '${id}'.`), { code: "E_RUN_NOT_FOUND" });
		const inspection: RunInspection = { metadata };
		if (includeTranscript) {
			inspection.transcriptPreview = transcriptPreview(metadata.transcriptPath, 12000);
			inspection.stderrPreview = boundedPreview(metadata.stderrPath, 4000);
		}
		return inspection;
	}

	mostRecentRunId(): string | null {
		const active = this.activeRun;
		const runs = listRuns(this.ports.agentDir, 50);
		if (active) return active.id;
		return runs[0]?.runId ?? null;
	}

	recentRunIds(limit = 8): string[] {
		return listRuns(this.ports.agentDir, limit).map((r) => r.runId);
	}

	// ── Status ─────────────────────────────────────────────────────────────

	getStatus(activeTools: string[] | "degraded", projectRoot?: string): DelegateStatus {
		const cfg = this.liveConfig;
		const runs = listRuns(this.ports.agentDir, 10);
		const active = this.activeRun;
		const last = runs.find((r) => r.runId !== active?.id) ?? runs[0];
		let timeouts: DelegateStatus["timeouts"] = {
			hardMs: cfg.hardTimeoutMs,
			inactivityMs: cfg.inactivityTimeoutMs,
			source: "user",
			userHardMs: cfg.hardTimeoutMs,
			userInactivityMs: cfg.inactivityTimeoutMs,
		};
		if (projectRoot) {
			const overlay = applyProjectOverlay(cfg, projectRoot) as unknown as DelegateConfigV1 & {
				projectOverrides: string[];
				projectCorrupt?: string;
			};
			const { projectOverrides, projectCorrupt, ...rest } = overlay;
			const eff = rest as unknown as DelegateConfigV1;
			const projectSetsHard = projectOverrides.includes("hardTimeoutMs");
			timeouts = {
				hardMs: eff.hardTimeoutMs,
				inactivityMs: eff.inactivityTimeoutMs,
				source: projectSetsHard ? "project" : "user",
				userHardMs: cfg.hardTimeoutMs,
				userInactivityMs: cfg.inactivityTimeoutMs,
				...(projectSetsHard ? { projectHardMs: eff.hardTimeoutMs } : {}),
				projectPath: projectConfigPath(projectRoot),
				projectOverrides,
				...(projectCorrupt ? { projectCorrupt } : {}),
			};
		}
		return {
			modeEnabled: this.isStrict(),
			activeTools: this.isStrict() ? ["delegate"] : activeTools,
			activeRun: active ? { runId: active.id, role: active.role, startedAt: active.startedAt } : null,
			lastRun: last ? { runId: last.runId, role: last.role, state: last.state, finishedAt: last.finishedAt, durationMs: last.durationMs } : null,
			defaultRole: cfg.defaultRole,
			timeouts,
			store: pathsForAgentDir(this.ports.agentDir),
		};
	}

	paths(): DelegatePaths {
		return pathsForAgentDir(this.ports.agentDir);
	}

	// ── Doctor ─────────────────────────────────────────────────────────────

	doctor(): DoctorReport {
		const checks: DoctorCheck[] = [];
		const cfg = this.liveConfig;
		const agentDir = this.ports.agentDir;

		// 1. Pi invocation resolution.
		try {
			const inv = (this.ports.resolveInvocation ?? resolvePiInvocation)();
			const fsOk = inv.command === "pi" || fs.existsSync(inv.command);
			checks.push({
				name: "pi-invocation",
				status: fsOk ? "ok" : "warning",
				detail: `${inv.command} ${inv.args.join(" ")}`.trim(),
			});
		} catch (error) {
			checks.push({ name: "pi-invocation", status: "error", detail: (error as Error).message });
		}

		// 2. Model availability (last known request context).
		const lastModel = this.lastModelSeen;
		checks.push({
			name: "model",
			status: lastModel ? "ok" : "warning",
			detail: lastModel ?? "no parent model captured yet",
		});

		// 3. Role prompt readability.
		for (const roleName of ["general", "research"] as const) {
			const role = DELEGATE_ROLES[roleName];
			const ok = rolePromptExists(role);
			checks.push({ name: `role-${roleName}-prompt`, status: ok ? "ok" : "error", detail: role.promptPath });
		}

		// 4. Run store writability + permissions.
		try {
			const runsDir = runPaths(agentDir, "_probe").runsDir;
			fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
			const probePath = runPaths(agentDir, "_probe").runsDir + "/.probe";
			fs.writeFileSync(probePath, "x", { mode: 0o600 });
			const mode = fs.statSync(probePath).mode & 0o777;
			const dirMode = fs.statSync(runPaths(agentDir, "_probe").runsDir).mode & 0o777;
			fs.unlinkSync(probePath);
			checks.push({
				name: "run-store",
				status: mode === 0o600 && dirMode === 0o700 ? "ok" : "warning",
				detail: `runs dir ${dirMode.toString(8)}, files ${mode.toString(8)}`,
			});
		} catch (error) {
			checks.push({ name: "run-store", status: "error", detail: (error as Error).message });
		}

		// 5. delegate active-tool registration.
		const activeToolsNow = this.lastActiveTools;
		checks.push({
			name: "delegate-registration",
			status: activeToolsNow.includes("delegate") ? "ok" : "error",
			detail: activeToolsNow.includes("delegate") ? "delegate is registered" : "delegate is NOT in the active tool set",
		});

		// 6. Strict gate/mode consistency.
		const strict = this.isStrict();
		const consistencyOk = !strict || activeToolsNow.length === 0 || (activeToolsNow.length === 1 && activeToolsNow[0] === "delegate");
		checks.push({
			name: "strict-consistency",
			status: !strict ? "ok" : consistencyOk ? "ok" : "warning",
			detail: strict ? "strict enforced; gate is authoritative" : "normal mode",
		});

		// 7. Firecrawl research path.
		const registered = this.lastRegisteredTools;
		const hasFirecrawl = registered.some((t) => /firecrawl/i.test(t));
		checks.push({
			name: "research-firecrawl-path",
			status: hasFirecrawl ? "ok" : "warning",
			detail: hasFirecrawl ? "Firecrawl-capable tool path present" : "no Firecrawl tool registered in this session",
		});

		// 8. Reddit supplementary path (informational).
		const hasReddit = registered.some((t) => /reddit/i.test(t));
		checks.push({
			name: "research-reddit-path",
			status: hasReddit ? "ok" : "warning",
			detail: hasReddit ? "Reddit tool path present" : "Reddit not available (supplemental)",
		});

		// 9. Stale nonterminal receipts.
		const stale = listRuns(agentDir, 100).filter((r) => !isTerminal(r.state));
		checks.push({
			name: "stale-receipts",
			status: stale.length === 0 ? "ok" : "warning",
			detail: stale.length === 0 ? "none" : `${stale.length} nonterminal receipt(s) without owned child`,
		});

		// 10. Active child ownership.
		const activeInfo = this.activeRun;
		checks.push({
			name: "active-child",
			status: "ok",
			detail: activeInfo ? `${activeInfo.id} owned by pid ${activeInfo.runner.childPid ?? "?"}` : "none",
		});

		return { checks, ok: checks.every((c) => c.status !== "error") };
	}

	// Adapter refreshes these snapshots for doctor() without Pi imports here.
	private lastModelSeen: string | null = null;
	private lastActiveTools: string[] = [];
	private lastRegisteredTools: string[] = [];

	refreshDoctorContext(info: { model?: string; activeTools?: string[]; registeredTools?: string[] }): void {
		if (info.model) this.lastModelSeen = info.model;
		if (info.activeTools) this.lastActiveTools = [...info.activeTools];
		if (info.registeredTools) this.lastRegisteredTools = [...info.registeredTools];
	}

	/** Startup: stale nonterminal receipts become crashed; never kills PIDs. */
	markOrphansOnStartup(): string[] {
		return markOrphanedRuns(this.ports.agentDir);
	}
}

/** Parse a dashboard input: bare ms number or a duration string. */
function parseSettingValue(raw: string): number | null {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) return Number(trimmed);
	try {
		const parsed = parseDuration(trimmed);
		return parsed === undefined ? null : parsed;
	} catch {
		return null;
	}
}

function settingParseError(raw: string): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "Value is empty.";
	try {
		parseDuration(trimmed);
		return "Value must be a duration (e.g. 30m, 2h, 1d) or bare ms.";
	} catch (error) {
		return (error as Error).message;
	}
}

function isTerminal(state: string): boolean {
	return ["succeeded", "failed", "cancelled", "timed_out_idle", "timed_out_hard", "crashed"].includes(state);
}

/**
 * Read a transcript envelope back as readable text: decode each record
 * (UTF-8 `raw`, or base64 fallback for non-UTF-8 evidence), bounded.
 */
function transcriptPreview(filePath: string, maxChars: number): string {
	try {
		const buf = fs.readFileSync(filePath);
		if (buf.length > 200_000) {
			// Bound the work on huge transcripts: decode the newest records.
			const lines = buf.toString("utf8").split("\n");
			const tail = lines.slice(-Math.max(1, Math.floor(200_000 / 200))).filter((l) => l.trim());
			return decodeTranscriptLines(tail, maxChars, tail.length < lines.filter((l) => l.trim()).length);
		}
		const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
		return decodeTranscriptLines(lines, maxChars, false);
	} catch {
		return "";
	}
}

function decodeTranscriptLines(lines: string[], maxChars: number, hadMore: boolean): string {
	const decoded = lines
		.map((line) => {
			try {
				const rec = JSON.parse(line) as TranscriptRecordV1;
				return decodeTranscriptRecord(rec);
			} catch {
				return line; // non-envelope line kept verbatim
			}
		})
		.filter((t) => t.length > 0);
	let text = decoded.join("\n");
	if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… [truncated]`;
	return hadMore ? `… [earlier records omitted]\n${text}` : text;
}

function boundedPreview(filePath: string, maxBytes: number): string {
	try {
		const buf = fs.readFileSync(filePath);
		if (buf.length <= maxBytes) return buf.toString("utf8");
		const head = buf.subarray(0, maxBytes).toString("utf8");
		return `${head}\n… [truncated ${buf.length - maxBytes} more bytes]`;
	} catch {
		return "";
	}
}

function outcomeToRunResult(
	outcome: RunnerOutcome,
	metadata: RunMetadataV1,
	role: RoleName,
	model: string,
	thinkingLevel?: string,
	provenance?: { timeoutInfo?: string; modelNote?: string },
): DelegateRunResult {
	const ok = outcome.state === "succeeded";
	const details: DelegateDetails = {
		schemaVersion: 1,
		runId: outcome.runId,
		role,
		state: outcome.state,
		startedAt: outcome.startedAt || metadata.startedAt || metadata.createdAt,
		finishedAt: outcome.finishedAt || metadata.finishedAt || new Date().toISOString(),
		durationMs: outcome.durationMs,
		model,
		...(thinkingLevel ? { thinkingLevel } : {}),
		exitCode: outcome.exitCode,
		stopReason: outcome.stopReason,
		usage: outcome.usage,
		outputBytes: outcome.outputBytes,
		outputTruncated: outcome.outputTruncated,
		...(outcome.partialHandoff ? { partialHandoff: outcome.partialHandoff } : {}),
		...(provenance?.timeoutInfo ? { timeoutInfo: provenance.timeoutInfo } : {}),
		transcriptPath: outcome.transcriptPath,
		stderrPath: outcome.stderrPath,
		displayItems: outcome.displayItems,
	};
	const notes: string[] = [];
	if (provenance?.modelNote) notes.push(provenance.modelNote);
	if (outcome.partialHandoff) notes.push(`partial handoff captured (${Buffer.byteLength(outcome.partialHandoff, "utf8")} bytes) — inspect it before re-delegating or resume with resumeFrom: ${outcome.runId}`);
	return {
		ok,
		handoff: outcome.handoff,
		details,
		...(notes.length ? { modelNote: notes.join("; ") } : {}),
		...(outcome.error ? { error: outcome.error } : {}),
	};
}
