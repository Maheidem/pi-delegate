/**
 * delegate — branch-aware strict mode: replay, transitions, allowlist gate.
 *
 * This module owns mode policy only. It never touches child execution and
 * never performs filesystem I/O inside the gate. Every failure path
 * degrades toward restriction, never permissiveness (POL-003).
 */

import type {
	DelegateModeEntryV1,
	ModeGateDecision,
	ModeReplayResult,
	ModeResult,
	ModeRuntime,
	ModeTransitionContext,
	SessionEntryLike,
} from "./types.ts";
import { DELEGATE_MODE_CUSTOM_TYPE } from "./types.ts";

export const STRICT_ALLOWED_TOOLS = new Set(["delegate", "delegate_status", "delegate_send", "delegate_answer"]);
export const STRICT_ACTIVE_TOOLS = ["delegate", "delegate_status", "delegate_send", "delegate_answer"];

export const STRICT_OVERLAY = [
	"[DELEGATION-MODE OVERLAY — enforced by the delegate extension]",
	"Strict delegation mode is ACTIVE. You are a coordinator only.",
	"- All substantive work (reading, research, inspection, editing, running commands) MUST go through the delegate tool.",
	"- Verification MUST be delegated: delegate a verification task rather than checking directly.",
	"- You may use plain text to clarify scope, coordinate, and synthesize child handoffs.",
	"- When a task is underspecified, ask the user clarifying questions in plain text.",
	"- Never claim to have directly inspected or changed files in this mode; only child results count.",
	"- You cannot disable this mode; only the user can, via /delegate off.",
].join("\n");

// ── Pure replay ──────────────────────────────────────────────────────────

function isModeEntry(entry: unknown): entry is { customType: string; data: unknown } {
	if (!entry || typeof entry !== "object") return false;
	const e = entry as Record<string, unknown>;
	return e.type === "custom" && e.customType === DELEGATE_MODE_CUSTOM_TYPE;
}

function parseModeEntry(data: unknown): DelegateModeEntryV1 | null {
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	if (d.schemaVersion !== 1) return null;
	if (typeof d.enabled !== "boolean") return null;
	if (typeof d.changedAt !== "string" || !d.changedAt) return null;
	if (d.source !== "command") return null;
	return d as unknown as DelegateModeEntryV1;
}

/**
 * Replay delegate-mode entries over a root-to-leaf branch (the result of
 * `ctx.sessionManager.getBranch()`). The latest VALID entry wins. Malformed
 * entries are skipped with diagnostics and never imply a permissive
 * transition. An empty branch yields normal mode.
 */
export function replayModeEntries(branch: SessionEntryLike[]): ModeReplayResult {
	const diagnostics: string[] = [];
	let modeEnabled = false;
	let sawAny = false;

	for (const entry of branch) {
		if (!isModeEntry(entry)) continue;
		sawAny = true;
		const parsed = parseModeEntry(entry.data);
		if (!parsed) {
			diagnostics.push(
				`malformed ${DELEGATE_MODE_CUSTOM_TYPE} entry ignored: ${JSON.stringify(entry.data ?? null).slice(0, 200)}`,
			);
			continue;
		}
		modeEnabled = parsed.enabled;
	}

	return { hydrated: true, modeEnabled, diagnostics };
}

export function newModeRuntime(): ModeRuntime {
	return {
		hydrated: false,
		modeEnabled: false,
		persistenceDegraded: false,
		restoreTools: [],
		blockedThisTurn: new Map(),
	};
}

export function modeRuntimeIsStrict(runtime: ModeRuntime): boolean {
	return runtime.hydrated && runtime.modeEnabled;
}

/**
 * Hydrate the runtime from a branch replay. If the replay result conflicts
 * with a currently enforced runtime, the stricter state wins until an
 * explicit transition runs (a replay failure never un-gates).
 */
export function applyReplayToRuntime(runtime: ModeRuntime, replay: ModeReplayResult): ModeReplayResult {
	runtime.hydrated = true;
	const desired = replay.modeEnabled;
	if (!runtime.modeEnabled && !desired) {
		runtime.restoreTools = [];
	} else if (runtime.modeEnabled && !desired) {
		// Navigated away from the enabling entry: leave tool-set repair to
		// the lifecycle handler (which restores tools), but clear the flag.
		runtime.modeEnabled = false;
	} else {
		runtime.modeEnabled = desired;
	}
	return replay;
}

// ── Gate ────────────────────────────────────────────────────────────────

/**
 * The authoritative strict-mode allowlist decision (POL-001: allowlist,
 * never denylist). Pure except for the blocked counter; exceptions MUST
 * fail closed.
 */
export function gateToolCall(runtime: ModeRuntime, toolName: unknown): ModeGateDecision {
	try {
		if (!modeRuntimeIsStrict(runtime)) return { block: false };
		if (typeof toolName !== "string" || !STRICT_ALLOWED_TOOLS.has(toolName)) {
			const name = typeof toolName === "string" ? toolName : "<unknown>";
			const count = (runtime.blockedThisTurn.get(name) ?? 0) + 1;
			runtime.blockedThisTurn.set(name, count);
			return {
				block: true,
				reason:
					`[DELEGATION-MODE] '${name}' is blocked. ` +
					`The parent is coordination-only. Use delegate({ task, role }) ` +
					`or ask the user to run /delegate off.` +
					(count > 1 ? " Do not retry this tool." : ""),
			};
		}
		return { block: false };
	} catch {
		return {
			block: true,
			reason: "[DELEGATION-MODE] Policy evaluation failed closed; no tool executed.",
		};
	}
}

export function resetBlockedCounters(runtime: ModeRuntime): void {
	runtime.blockedThisTurn.clear();
}

/**
 * Drift handling before a provider call (FR-004, NFR-001): remember any
 * tools activated while strict and re-hide them so the advertised set is
 * exactly ['delegate']. Returns true when drift existed.
 */
export function syncStrictToolSet(
	runtime: ModeRuntime,
	currentActive: readonly string[],
	applyStrictSet: () => void,
): boolean {
	if (!modeRuntimeIsStrict(runtime)) return false;
	const strict = STRICT_ACTIVE_TOOLS;
	const drifted =
		currentActive.length !== strict.length ||
		currentActive.some((tool, i) => tool !== strict[i]);
	if (!drifted) return false;
	// Remember names for later restoration, then re-hide immediately.
	for (const tool of currentActive) {
		if (!runtime.restoreTools.includes(tool)) runtime.restoreTools.push(tool);
	}
	try {
		applyStrictSet();
	} catch {
		// The gate remains authoritative; visibility is degraded.
	}
	return true;
}

// ── Transitions ─────────────────────────────────────────────────────────

/**
 * `/delegate on` — spec §8.4 ordering. Step 5 (setActiveTools) failure
 * keeps the gate strict with degraded visibility. Step 6 (persist) failure
 * keeps strict mode active and flags persistenceDegraded.
 */
export async function enableStrict(runtime: ModeRuntime, ctx: ModeTransitionContext): Promise<ModeResult> {
	if (runtime.modeEnabled) {
		return { ok: true, message: "Already in strict delegation mode." };
	}
	if (ctx.isBusy()) {
		let approved = false;
		try {
			approved = await ctx.requestAbortConfirmation();
		} catch {
			approved = false;
		}
		if (!approved) {
			return {
				ok: false,
				code: "E_PARENT_BUSY",
				message: "Parent is busy and the user did not approve aborting the current turn.",
			};
		}
		try {
			ctx.abort();
			await ctx.waitForIdle();
		} catch {
			return {
				ok: false,
				code: "E_PARENT_BUSY",
				message: "Could not bring the parent to idle before activating strict mode.",
			};
		}
	}

	// Step 3: capture the current ordered active-tool list.
	let baseline: string[] = [];
	try {
		baseline = ctx.getActiveTools();
	} catch {
		baseline = [];
	}
	runtime.restoreTools = [...baseline];

	// Step 4: the hard gate becomes active BEFORE schemas change.
	runtime.modeEnabled = true;

	// Step 5: visibility/cache optimization (not the authority).
	let visibilityOk = true;
	try {
		ctx.setActiveTools(STRICT_ACTIVE_TOOLS);
	} catch {
		visibilityOk = false;
	}

	// Step 6: persist the enabling entry.
	let persistOk = true;
	try {
		ctx.persistModeEntry({
			schemaVersion: 1,
			enabled: true,
			changedAt: new Date().toISOString(),
			source: "command",
		});
	} catch {
		persistOk = false;
		runtime.persistenceDegraded = true;
	}

	// Step 7 + 8: status + notification.
	ctx.setFooterStatus("delegate: strict");
	const notes: string[] = [];
	if (!visibilityOk) notes.push("tool visibility is degraded (the gate remains authoritative)");
	if (!persistOk) notes.push("the mode entry could not be persisted; resume cannot be guaranteed");
	const message = notes.length
		? `Strict delegation mode is ON with issues: ${notes.join("; ")}.`
		: "Strict delegation mode is ON: only delegate is available to the parent model.";
	ctx.notify(message, persistOk ? "info" : "warning");
	return { ok: true, message };
}

/**
 * `/delegate off` — spec §8.5 ordering. No window exists in which
 * unpersisted deactivation makes parent tools executable.
 */
export async function disableStrict(runtime: ModeRuntime, ctx: ModeTransitionContext): Promise<ModeResult> {
	if (!runtime.modeEnabled) {
		return { ok: true, message: "Already in normal mode." };
	}

	// Step 2: restore tools while the gate is still active.
	let restored = true;
	try {
		ctx.setActiveTools(runtime.restoreTools);
	} catch {
		restored = false;
	}
	if (!restored) {
		// Step 3: reapply the strict set, keep strict, report.
		try {
			ctx.setActiveTools(STRICT_ACTIVE_TOOLS);
		} catch {
			// gate remains
		}
		ctx.notify("Could not restore normal tools; strict mode remains active.", "warning");
		return {
			ok: false,
			code: "E_TOOL_RESTORE",
			message: "Normal active tools could not be restored; strict mode remains active.",
		};
	}

	// Step 4: persist the disabling entry.
	let persistOk = true;
	try {
		ctx.persistModeEntry({
			schemaVersion: 1,
			enabled: false,
			changedAt: new Date().toISOString(),
			source: "command",
		});
	} catch {
		persistOk = false;
	}
	if (!persistOk) {
		// Step 5: reapply strict set, keep strict mode active.
		try {
			ctx.setActiveTools(STRICT_ACTIVE_TOOLS);
		} catch {
			// gate remains
		}
		runtime.persistenceDegraded = true;
		ctx.notify("Mode entry could not be persisted; strict mode remains active.", "warning");
		return {
			ok: false,
			code: "E_MODE_PERSIST",
			message: "The disabling mode entry could not be persisted; strict mode remains active.",
		};
	}

	// Steps 6 + 7: clear runtime state.
	runtime.modeEnabled = false;
	runtime.persistenceDegraded = false;
	runtime.restoreTools = [];
	resetBlockedCounters(runtime);
	ctx.setFooterStatus(undefined);
	ctx.notify("Strict delegation mode is OFF: normal tool set restored.", "info");
	return { ok: true, message: "Strict delegation mode is OFF." };
}
