/**
 * delegate — global configuration: defaults, validation, migration, atomic
 * persistence. Strict mode is NOT stored here; it is session-scoped state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RoleName } from "./types.ts";
import { ROLE_NAMES } from "./types.ts";

export interface DelegateConfigV1 {
	schemaVersion: 1;
	defaultRole: RoleName;
	maxTaskBytes: number;
	maxResultBytes: number;
	inactivityTimeoutMs: number;
	hardTimeoutMs: number;
	killGraceMs: number;
	/** R2: how long to wait for a killed child's final handoff answer. */
	handoffGraceMs: number;
	/** Bounded wait for the mandatory-handoff enforcement answer (default 60 s). */
	handoffEnforceTimeoutMs: number;
	/** Concurrent calls beyond the active child wait in this FIFO queue. */
	queueLimit: number;
	/** R1: watchdog budget while a tool call is in flight (default: hard). */
	stuckToolTimeoutMs?: number;
	maxRuns: number;
	maxRunAgeDays: number;
	updateThrottleMs: number;
	/** R22: default execution mode for delegations without an explicit override. */
	defaultExecution: "background" | "foreground";
	/** R9: concurrent background children (default 3, clamp 1–8). */
	maxBackgroundRuns: number;
	/** R17/R18: ask_parent channel (background children). */
	askParent: {
		enabled: boolean;
		timeoutMs: number;
		maxPerRun: number;
	};
}

export const DEFAULT_DELEGATE_CONFIG: DelegateConfigV1 = {
	schemaVersion: 1,
	defaultRole: "general",
	maxTaskBytes: 32768,
	maxResultBytes: 51200,
	inactivityTimeoutMs: 300_000,
	hardTimeoutMs: 1_800_000,
	killGraceMs: 5_000,
	handoffGraceMs: 90_000,
	handoffEnforceTimeoutMs: 60_000,
	queueLimit: 3,
	stuckToolTimeoutMs: undefined,
	maxRuns: 50,
	maxRunAgeDays: 30,
	updateThrottleMs: 100,
	defaultExecution: "background",
	maxBackgroundRuns: 3,
	askParent: {
		enabled: true,
		timeoutMs: 600_000,
		maxPerRun: 5,
	},
};

const MIN_VALUES: Partial<Record<keyof DelegateConfigV1, number>> = {
	maxTaskBytes: 1024,
	maxResultBytes: 1024,
	inactivityTimeoutMs: 1_000,
	hardTimeoutMs: 1_000,
	killGraceMs: 100,
	handoffGraceMs: 1_000,
	handoffEnforceTimeoutMs: 1_000,
	queueLimit: 0,
	stuckToolTimeoutMs: 1_000,
	maxRuns: 1,
	maxRunAgeDays: 1,
	updateThrottleMs: 0,
	maxBackgroundRuns: 1,
};

const MAX_VALUES: Partial<Record<keyof DelegateConfigV1, number>> = {
	maxTaskBytes: 1_048_576,
	maxResultBytes: 10_485_760,
	inactivityTimeoutMs: 86_400_000,
	hardTimeoutMs: 604_800_000,
	killGraceMs: 60_000,
	handoffGraceMs: 600_000,
	handoffEnforceTimeoutMs: 600_000,
	queueLimit: 20,
	stuckToolTimeoutMs: 604_800_000,
	maxRuns: 10_000,
	maxRunAgeDays: 3650,
	updateThrottleMs: 5_000,
	maxBackgroundRuns: 8,
};

/**
 * Clamp/normalize a raw value into a valid config. Unknown future keys are
 * deliberately preserved in the returned `extras` so a save round-trips
 * them; they are diagnosed but never silently dropped.
 */
export function normalizeConfig(
	raw: unknown,
): { config: DelegateConfigV1; unknownKeys: string[] } {
	const base: DelegateConfigV1 = { ...DEFAULT_DELEGATE_CONFIG };
	const unknownKeys: string[] = [];
	const extras: Record<string, unknown> = {};
	const known = new Set<string>(Object.keys(base));

	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const record = raw as Record<string, unknown>;
		// §5.1: missing or old schemaVersion migrates to v1; future versions
		// are corrupt (fail closed).
		if ("schemaVersion" in record) {
			const v = record.schemaVersion;
			const numeric = typeof v === "number" ? v : Number(v);
			if (!Number.isFinite(numeric) || numeric > 1) {
				throw new Error(
					`unsupported config schemaVersion: ${String(v)} (expected <= 1)`,
				);
			}
		}
		for (const key of Object.keys(record)) {
			if (!known.has(key)) {
				unknownKeys.push(key);
				extras[key] = record[key];
				continue;
			}
			applyKnownField(base, key, record[key]);
		}
	} else if (raw !== undefined && raw !== null) {
		throw new Error("config must be a JSON object");
	}

	return { config: base, unknownKeys };
}

function applyKnownField(config: DelegateConfigV1, key: string, value: unknown): void {
	if (key === "schemaVersion") return;
	if (key === "defaultRole") {
		if ((ROLE_NAMES as readonly string[]).includes(String(value))) {
			config.defaultRole = value as RoleName;
		}
		return;
	}
	// R17: nested askParent block — merge field-by-field with clamps.
	if (key === "defaultExecution") {
		// R22: accept exactly the two enum words; anything else keeps the default.
		if (value === "background" || value === "foreground") {
			config.defaultExecution = value;
		}
		return;
	}
	if (key === "askParent") {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const raw = value as Record<string, unknown>;
		if (typeof raw.enabled === "boolean") config.askParent.enabled = raw.enabled;
		if (Number.isFinite(Number(raw.timeoutMs))) {
			config.askParent.timeoutMs = Math.min(3_600_000, Math.max(5_000, Number(raw.timeoutMs)));
		}
		if (Number.isFinite(Number(raw.maxPerRun))) {
			config.askParent.maxPerRun = Math.min(20, Math.max(1, Math.trunc(Number(raw.maxPerRun))));
		}
		return;
	}
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric)) return;
	const min = MIN_VALUES[key as keyof DelegateConfigV1];
	const max = MAX_VALUES[key as keyof DelegateConfigV1];
	config[key as keyof DelegateConfigV1] = Math.min(
		max ?? Number.MAX_SAFE_INTEGER,
		Math.max(min ?? 0, Math.trunc(numeric)),
	) as never;
}

export interface ConfigLoadResult {
	config: DelegateConfigV1;
	unknownKeys: string[];
	/** True when a corrupt file was preserved and defaults recovered. */
	recoveredFromCorrupt: boolean;
	corruptEvidencePath?: string;
}

/**
 * Load config from `<agentDir>/delegate/config.json`.
 * Corrupt files are renamed with timestamp evidence and defaults recover.
 * Missing files simply load defaults (nothing is written).
 */
export function loadConfig(agentDir: string, configPath?: string): ConfigLoadResult {
	const cfgPath = configPath ?? path.join(agentDir, "delegate", "config.json");
	let raw: unknown;
	try {
		const text = fs.readFileSync(cfgPath, "utf8");
		raw = JSON.parse(text);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { config: { ...DEFAULT_DELEGATE_CONFIG }, unknownKeys: [], recoveredFromCorrupt: false };
		}
		// Preserve the corrupt file as evidence, then recover with defaults.
		let evidencePath: string | undefined;
		try {
			evidencePath = `${cfgPath}.corrupt-${Date.now()}`;
			fs.renameSync(cfgPath, evidencePath);
			fs.chmodSync(evidencePath, 0o600);
		} catch {
			// If we cannot preserve evidence, still recover with defaults.
		}
		return {
			config: { ...DEFAULT_DELEGATE_CONFIG },
			unknownKeys: [],
			recoveredFromCorrupt: true,
			corruptEvidencePath: evidencePath,
		};
	}
	try {
		const { config, unknownKeys } = normalizeConfig(raw);
		return { config, unknownKeys, recoveredFromCorrupt: false };
	} catch {
		// Normalize failed (e.g. unsupported schemaVersion): same recovery.
		let evidencePath: string | undefined;
		try {
			evidencePath = `${cfgPath}.corrupt-${Date.now()}`;
			fs.renameSync(cfgPath, evidencePath);
			fs.chmodSync(evidencePath, 0o600);
		} catch {
			// ignore
		}
		return {
			config: { ...DEFAULT_DELEGATE_CONFIG },
			unknownKeys: [],
			recoveredFromCorrupt: true,
			corruptEvidencePath: evidencePath,
		};
	}
}

/** Clamp a per-invocation timeout into the configured hard-timeout bounds. */
export function clampTimeoutMs(value: number): number {
	const min = MIN_VALUES.hardTimeoutMs ?? 1_000;
	const max = MAX_VALUES.hardTimeoutMs ?? 604_800_000;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Clamp one numeric config field; null when the key is not a numeric knob. */
export function clampConfigField(key: string, value: number): number | null {
	if (key === "schemaVersion" || key === "defaultRole") return null;
	if (!Number.isFinite(value)) return null;
	const min = MIN_VALUES[key as keyof DelegateConfigV1];
	const max = MAX_VALUES[key as keyof DelegateConfigV1];
	if (min === undefined && max === undefined) return null;
	return Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, Math.trunc(value)));
}

/**
 * Resolve the effective run timeouts. Priority: per-invocation > project
 * > user (baseCfg already carries the project overlay). The inactivity
 * watchdog is capped at half of the hard timeout regardless of source, so
 * a long-silent child can never outlive its watchdog.
 */
export function resolveRunTimeouts(
	baseCfg: DelegateConfigV1,
	timeoutMs?: number,
): { hardMs: number; inactivityMs: number; stuckToolMs: number; hardSource: "per-run" | "config" } {
	const perRun = timeoutMs !== undefined;
	const hardMs = perRun ? clampTimeoutMs(timeoutMs!) : baseCfg.hardTimeoutMs;
	const inactivityMs = Math.min(
		baseCfg.inactivityTimeoutMs,
		Math.max(1_000, Math.floor(hardMs / 2)),
	);
	// R1: while a tool call is in flight the watchdog uses the stuck-tool
	// budget (default: the full hard timeout), so legitimate long-running
	// tool calls (test matrices, benchmarks, soaks) are never idle-killed.
	const stuckToolMs = Math.min(
		baseCfg.stuckToolTimeoutMs ?? hardMs,
		hardMs,
	);
	return { hardMs, inactivityMs, stuckToolMs, hardSource: perRun ? "per-run" : "config" };
}

/** Human-readable duration for TUI display and prefilled inputs. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const totalSec = Math.round(ms / 1_000);
	if (totalSec < 60) return `${totalSec}s`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
	const h = Math.floor(m / 60);
	const remM = m % 60;
	if (h < 24) return remM ? `${h}h ${remM}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const remH = h % 24;
	return remH ? `${d}d ${remH}h` : `${d}d`;
}

/**
 * Merge fields into the project-wide config file (overlay semantics: only
 * the given keys change; other project keys are preserved). A corrupt
 * existing file is preserved as timestamped evidence and replaced.
 */
export function saveProjectConfig(projectRoot: string, fields: Partial<DelegateConfigV1>): string {
	const pPath = projectConfigPath(projectRoot);
	let existing: Record<string, unknown> = {};
	try {
		const raw = JSON.parse(fs.readFileSync(pPath, "utf8"));
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			existing = raw as Record<string, unknown>;
		} else {
			throw new Error("project config is not a JSON object");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			try {
				const evidence = `${pPath}.corrupt-${Date.now()}`;
				fs.renameSync(pPath, evidence);
				fs.chmodSync(evidence, 0o600);
			} catch {
				// evidence rename failed; still start fresh
			}
		}
	}
	const known = new Set<string>(Object.keys(DEFAULT_DELEGATE_CONFIG));
	for (const [key, value] of Object.entries(fields)) {
		if (known.has(key)) existing[key] = value;
	}
	fs.mkdirSync(path.dirname(pPath), { recursive: true });
	return atomicWriteJson(pPath, existing);
}

/**
 * Parse a human duration into milliseconds: "90s", "10m", "2h", "1d",
 * or a bare number (already ms). Returns undefined for empty input;
 * throws for malformed values (callers surface a stable error).
 */
export function parseDuration(input: string): number | undefined {
	const text = (input ?? "").trim().toLowerCase();
	if (!text) return undefined;
	const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(text);
	if (m) {
		const value = Number(m[1]);
		const unit = m[2];
		const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
		return Math.round(value * factor);
	}
	if (/^\d+$/.test(text)) return Number(text);
	throw new Error(`invalid duration '${input}' (use e.g. 90s, 10m, 2h, 1d, or bare ms)`);
}

/**
 * Project-wide config path for a project root: `<root>/.pi/delegate/config.json`.
 * The project file is an OPTIONAL overlay: only fields present in it override
 * the user-wide config; it is never required to be schema-complete.
 */
export function projectConfigPath(projectRoot: string): string {
	return path.join(projectRoot, ".pi", "delegate", "config.json");
}

/**
 * Overlay a project-wide config file onto a base config (the user-wide
 * config in production; the app's live config for injected-config tests).
 * Project file semantics:
 *  - missing file → base unchanged (the normal case);
 *  - corrupt file → diagnosed via `projectCorrupt`, base still wins
 *    (a broken project file must never break delegations);
 *  - only keys PRESENT in the project file override (no default backfill);
 *  - values are clamped by the same min/max bounds as the user config.
 * Two diagnostic arrays, deliberately different:
 *  - `projectOverrides`: keys that CHANGE the effective value (equality vs
 *    base). Resolution/provenance logic depends on this — do not widen.
 *  - `projectSetKeys`: every known key explicitly PRESENT in the file,
 *    regardless of equality with the base. Display code must use this, so a
 *    project value that happens to equal the user value never renders as
 *    "not set". A key whose value is invalid is still reported as set (it
 *    is in the file); its effective value then equals the base value.
 * Returns a NEW config object; the base is never mutated.
 */
export function applyProjectOverlay(
	base: DelegateConfigV1,
	projectRoot: string,
): DelegateConfigV1 & { projectOverrides: string[]; projectSetKeys: string[]; projectCorrupt?: string } {
	const result: DelegateConfigV1 & { projectOverrides: string[]; projectSetKeys: string[]; projectCorrupt?: string } = {
		...base,
		projectOverrides: [],
		projectSetKeys: [],
	};
	const pPath = projectConfigPath(projectRoot);
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(pPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			result.projectCorrupt = pPath;
		}
		return result;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
	const record = raw as Record<string, unknown>;
	const known = new Set<string>(Object.keys(DEFAULT_DELEGATE_CONFIG));
	const overrides: string[] = [];
	const setKeys: string[] = [];
	for (const key of Object.keys(record)) {
		if (key === "schemaVersion") continue;
		if (!knownKey(key)) continue; // unknown keys in project overlay ignored
		// File truth: present in the project file counts as set even when the
		// normalized value equals the base value (the override list would omit it).
		setKeys.push(key);
		try {
			const probe: DelegateConfigV1 = { ...DEFAULT_DELEGATE_CONFIG };
			applyKnownField(probe, key, record[key]);
			const next = probe[key as keyof DelegateConfigV1] as number;
			if (next !== (base[key as keyof DelegateConfigV1] as number)) {
				result[key as keyof DelegateConfigV1] = next as never;
				overrides.push(key);
			}
		} catch {
			// invalid value for one key: skip it, keep base value
		}
	}
	result.projectOverrides = overrides;
	result.projectSetKeys = setKeys;
	return result;
}

function knownKey(key: string): boolean {
	return (Object.keys(DEFAULT_DELEGATE_CONFIG) as string[]).includes(key);
}

/**
 * Load the user-wide config, then overlay project-wide values on top.
 * Convenience wrapper over loadConfig + applyProjectOverlay.
 */
export function loadConfigCascade(
	agentDir: string,
	projectRoot?: string,
	configPath?: string,
): ConfigLoadResult & { projectOverrides: string[]; projectSetKeys: string[]; projectCorrupt?: string } {
	const base = loadConfig(agentDir, configPath);
	if (!projectRoot) {
		return { ...base, projectOverrides: [], projectSetKeys: [] };
	}
	const overlay = applyProjectOverlay(base.config, projectRoot);
	const { projectOverrides, projectSetKeys, projectCorrupt, ...rest } = overlay as unknown as DelegateConfigV1 & {
		projectOverrides: string[];
		projectSetKeys: string[];
		projectCorrupt?: string;
	};
	const config: DelegateConfigV1 = { ...(rest as unknown as DelegateConfigV1) };
	return {
		...base,
		config,
		projectOverrides: overlay.projectOverrides,
		projectSetKeys: overlay.projectSetKeys,
		projectCorrupt: overlay.projectCorrupt,
	};
}

/**
 * Persist config: temp file + fsync + close + rename inside the same
 * directory, mode 0600. Unknown future keys carried in `extraKeys` are
 * preserved on disk.
 */
export function saveConfig(
	agentDir: string,
	config: DelegateConfigV1,
	extraKeys: Record<string, unknown> = {},
	configPath?: string,
): string {
	const cfgPath = configPath ?? path.join(agentDir, "delegate", "config.json");
	const dir = path.dirname(cfgPath);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const payload: Record<string, unknown> = { ...config };
	for (const [key, value] of Object.entries(extraKeys)) payload[key] = value;
	return atomicWriteJson(cfgPath, payload);
}

/**
 * Atomic JSON replace: write a sibling temp file, fsync, close, rename.
 * Owner-only (0600). Exported for run-store.ts so both persistence modules
 * share one proven primitive.
 */
export function atomicWriteJson(filePath: string, value: unknown): string {
	const dir = path.dirname(filePath);
	const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
	const data = `${JSON.stringify(value, null, 2)}\n`;
	const handle = fs.openSync(tmp, "w", 0o600);
	try {
		fs.writeSync(handle, data, 0, "utf8");
		fs.fsyncSync(handle);
	} finally {
		fs.closeSync(handle);
	}
	fs.renameSync(tmp, filePath);
	return filePath;
}
