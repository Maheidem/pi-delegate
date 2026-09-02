/**
 * delegate — shared domain contracts.
 *
 * Pi-free types shared across config, mode, store, runner, application,
 * commands and the UI adapter. Anything that needs a Pi context must not
 * live here.
 */

// ── Roles ──────────────────────────────────────────────────────────────────

export const ROLE_NAMES = ["general", "research"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface DelegateRole {
	name: RoleName;
	description: string;
	/** Absolute path of the package-owned role prompt file. */
	promptPath: string;
	/** Closed child tool ceiling for this role. */
	tools: readonly string[];
	writeCapable: boolean;
}

// ── Errors ────────────────────────────────────────────────────────────────

export const DELEGATE_ERROR_CODES = [
	"E_INVALID_TASK",
	"E_INVALID_ROLE",
	"E_DELEGATE_BUSY",
	"E_PARENT_BUSY",
	"E_PROJECT_UNTRUSTED",
	"E_MODEL_UNAVAILABLE",
	"E_RESEARCH_TOOLS",
	"E_STORE",
	"E_SPAWN",
	"E_RPC_PROTOCOL",
	"E_RPC_PROMPT_REJECTED",
	"E_CHILD_EXIT",
	"E_CHILD_MODEL",
	"E_NO_HANDOFF",
	"E_CANCELLED",
	"E_TIMEOUT_IDLE",
	"E_TIMEOUT_HARD",
	"E_MODE_PERSIST",
	"E_TOOL_RESTORE",
	"E_ORPHANED_RUN",
] as const;
export type DelegateErrorCode = (typeof DELEGATE_ERROR_CODES)[number];

export interface DelegateError {
	code: DelegateErrorCode;
	/** Concise, safe for model/tool output. Never dumps stderr/env/transcripts. */
	message: string;
	runId?: string;
}

// ── Run lifecycle ─────────────────────────────────────────────────────────

export const RUN_TERMINAL_STATES = [
	"succeeded",
	"failed",
	"cancelled",
	"timed_out_idle",
	"timed_out_hard",
	"crashed",
] as const;
export type RunTerminalState = (typeof RUN_TERMINAL_STATES)[number];

export type RunState = "created" | "starting" | "running" | RunTerminalState;

export function isTerminalRunState(state: RunState): state is RunTerminalState {
	return (RUN_TERMINAL_STATES as readonly string[]).includes(state);
}

export interface DelegateUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export const EMPTY_USAGE: DelegateUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

export type RunSource = "tool" | "command";

/** Project-wide config path: `<projectRoot>/.pi/delegate/config.json`. */
export const PROJECT_DELEGATE_CONFIG_REL = ".pi/delegate/config.json";

export interface DelegateRequest {
	task: string;
	role: RoleName;
	source: RunSource;
	/** Filled by the application, never by the caller. */
	cwd: string;
	/** "provider/model-id" of the parent model. */
	parentModel: string;
	/** Parent thinking level, when available. */
	thinkingLevel?: string;
	projectTrusted: boolean;
	/** Per-invocation hard timeout (ms); overrides the config cascade. */
	timeoutMs?: number;
	/** Project root for the project-wide config overlay (optional). */
	projectRoot?: string;
}

/** Bounded, parent-visible tool result details (schema v1). */
export interface DelegateDetails {
	schemaVersion: 1;
	runId: string;
	role: RoleName;
	state: RunTerminalState;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	model: string;
	thinkingLevel?: string;
	exitCode?: number;
	stopReason?: string;
	usage: DelegateUsage;
	outputBytes: number;
	outputTruncated: boolean;
	transcriptPath: string;
	stderrPath: string;
	displayItems: DelegateDisplayItem[];
}

export type DelegateDisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface DelegateRunResult {
	ok: boolean;
	/** Bounded final handoff for the parent context ("" on failure). */
	handoff: string;
	details: DelegateDetails;
	error?: DelegateError;
}

/** Terminal outcome the runner reports back to the application. */
export interface RunnerOutcome {
	runId: string;
	state: RunTerminalState;
	handoff: string;
	outputBytes: number;
	outputTruncated: boolean;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	exitCode?: number;
	stopReason?: string;
	usage: DelegateUsage;
	displayItems: DelegateDisplayItem[];
	error?: DelegateError;
	transcriptPath: string;
	stderrPath: string;
	/** Display-safe recent child actions (bounded). */
	lastActions: string[];
}

// ── Run store ─────────────────────────────────────────────────────────────

export interface RunMetadataV1 {
	schemaVersion: 1;
	runId: string;
	state: RunState;
	role: RoleName;
	source: RunSource;
	cwd: string;
	task: string;
	taskSha256: string;
	model: string;
	thinkingLevel?: string;
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	pid?: number;
	exitCode?: number;
	stopReason?: string;
	errorCode?: DelegateErrorCode;
	errorMessage?: string;
	usage: DelegateUsage;
	outputBytes?: number;
	outputTruncated?: boolean;
	finalHandoff?: string;
	transcriptPath: string;
	stderrPath: string;
}

export interface TranscriptRecordV1 {
	schemaVersion: 1;
	sequence: number;
	receivedAt: string;
	stream: "stdout";
	/** UTF-8 text of the raw record (the normal case — readable). */
	raw?: string;
	/** Base64 fallback when the bytes are not valid UTF-8. */
	rawBase64?: string;
}

/** Decode a captured transcript record back to its original text. */
export function decodeTranscriptRecord(record: TranscriptRecordV1): string {
	if (typeof record.raw === "string") return record.raw;
	if (typeof record.rawBase64 === "string") return Buffer.from(record.rawBase64, "base64").toString("utf8");
	return "";
}

export interface DelegatePaths {
	agentDir: string;
	configPath: string;
	runsDir: string;
}

export interface RunInspection {
	metadata: RunMetadataV1;
	/** Included only when the user explicitly asks for the transcript. */
	transcriptPreview?: string;
	stderrPreview?: string;
}

// ── Strict mode ───────────────────────────────────────────────────────────

export const DELEGATE_MODE_CUSTOM_TYPE = "delegate-mode";

export interface DelegateModeEntryV1 {
	schemaVersion: 1;
	enabled: boolean;
	changedAt: string;
	source: "command";
}

/** Minimal structural view of a session entry, for branch replay. */
export interface SessionEntryLike {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

export interface ModeReplayResult {
	hydrated: true;
	modeEnabled: boolean;
	/** Diagnostics for malformed/ignored entries. */
	diagnostics: string[];
}

export interface ModeRuntime {
	hydrated: boolean;
	modeEnabled: boolean;
	persistenceDegraded: boolean;
	/** Ordered active-tool snapshot captured on entry to strict mode. */
	restoreTools: string[];
	/** toolName -> blocked attempts this turn. */
	blockedThisTurn: Map<string, number>;
}

export interface ModeGateDecision {
	block: boolean;
	reason?: string;
}

export type ModeResult =
	| { ok: true; message: string }
	| { ok: false; code: DelegateErrorCode; message: string };

/**
 * Port surface the adapter (index.ts) implements so mode.ts stays Pi-free.
 * Every failure path must degrade toward restriction, never permissiveness.
 */
export interface ModeTransitionContext {
	isBusy(): boolean;
	/** Ask the user to abort the in-flight turn before activating. */
	requestAbortConfirmation(): Promise<boolean>;
	abort(): void;
	waitForIdle(): Promise<void>;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	persistModeEntry(entry: DelegateModeEntryV1): void;
	setFooterStatus(text: string | undefined): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
}

// ── Status / doctor ───────────────────────────────────────────────────────

export interface DelegateStatus {
	modeEnabled: boolean;
	activeTools: string[] | "degraded";
	activeRun: { runId: string; role: RoleName; startedAt: string } | null;
	lastRun: {
		runId: string;
		role: RoleName;
		state: RunState;
		finishedAt?: string;
		durationMs?: number;
	} | null;
	defaultRole: RoleName;
	store: DelegatePaths;
}

export interface DoctorCheck {
	name: string;
	status: "ok" | "warning" | "error";
	detail: string;
}

export interface DoctorReport {
	checks: DoctorCheck[];
	ok: boolean;
}

// ── Streaming / renderer state ───────────────────────────────────────────

export interface RunStreamUpdate {
	runId: string;
	role: RoleName;
	phase: "starting" | "running" | `tool:${string}` | "finalizing";
	elapsedMs: number;
	lastActions: string[];
	usage: DelegateUsage;
}

export type RunHooks = {
	onUpdate?: (update: RunStreamUpdate) => void;
	abortSignal?: AbortSignal;
};

/** A second invocation while a child is active: busy, with identity. */
export interface BusyRunError {
	ok: false;
	busy: true;
	runId: string;
	role: RoleName;
	message: string;
	error: DelegateError;
}

export type RunAttemptResult = DelegateRunResult | BusyRunError;

export interface CancelResult {
	ok: boolean;
	runId?: string;
	message: string;
	error?: DelegateError;
}

// ── Application ports (§11 Pi-free port surface) ────────────────────────

import type { DelegateConfigV1 } from "./config.ts";

export type DelegateAppConfig = DelegateConfigV1;

export interface DelegateApplicationPorts {
	agentDir: string;
	config: DelegateAppConfig;
	/** Injectable Pi invocation resolver for tests. */
	resolveInvocation?: (piPath?: string) => { command: string; args: string[] };
}

export interface DelegateApplication {
	isStrict(): boolean;
	getModeRuntime(): ModeRuntime;
	hydrateFromBranch(branch: SessionEntryLike[]): void;
	gate(toolName: unknown): ModeGateDecision;
	enableStrict(ctx: ModeTransitionContext): Promise<ModeResult>;
	disableStrict(ctx: ModeTransitionContext): Promise<ModeResult>;
	run(request: DelegateRequest, hooks?: RunHooks): Promise<RunAttemptResult>;
	cancel(runId?: string): Promise<CancelResult>;
	inspect(runId?: string, includeTranscript?: boolean): RunInspection;
	doctor(): DoctorReport;
	getStatus(activeTools: string[] | "degraded"): DelegateStatus;
	patchConfig(key: string, rawValue: string): string | null;
	paths(): DelegatePaths;
}
