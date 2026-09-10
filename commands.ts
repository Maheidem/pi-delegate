/**
 * delegate — /delegate grammar and intents.
 *
 * Reserved subcommands are matched before the general-task fallback.
 * This module owns grammar only: no mutation, no rendering.
 */

import type { RoleName } from "./types.ts";
import { ROLE_NAMES } from "./types.ts";
import { parseDuration } from "./config.ts";

export type DelegateIntent =
	| { kind: "dashboard" }
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "status" }
	| { kind: "paths" }
	| { kind: "doctor" }
	| { kind: "help" }
	| { kind: "cancel"; runId?: string }
	| { kind: "answer"; runId: string; text: string }
	| { kind: "bg"; role: RoleName; task: string; timeoutMs?: number; execution?: "background" | "foreground" }
	| { kind: "fg"; role: RoleName; task: string; timeoutMs?: number; execution?: "background" | "foreground" }
	| { kind: "inspect"; runId?: string }
	| { kind: "resume"; runId?: string; task: string; timeoutMs?: number; execution?: "background" | "foreground" }
	| { kind: "peek"; runId?: string }
	| { kind: "run"; role: RoleName; task: string; explicit: boolean; timeoutMs?: number; execution?: "background" | "foreground" }
	| { kind: "set"; field: string; value: string }
	| { kind: "set-project"; field: string; value: string }
	| { kind: "invalid"; token: string; usage: string };

export const DELEGATE_USAGE = [
	"/delegate                          dashboard (TUI: edit base timeouts) or status (headless)",
	"/delegate on                        enable strict delegation mode",
	"/delegate off                       disable strict delegation mode",
	"/delegate status                    mode, active run, last run",
	"/delegate paths                     config and run-store paths",
	"/delegate doctor                    diagnostics (no LLM call)",
	"/delegate cancel [run-id]           cancel the active (or matching) run",
	"/delegate resume <run-id> <task...>  continue a prior run's child session",
	"/delegate peek [run-id]             live/final feed of a run's child activity",
	"/delegate inspect [run-id]          show run metadata (defaults to latest)",
	"/delegate run <general|research> <task...>   run with an explicit role",
	"/delegate set <field> <value>       set a user-wide config knob (e.g. set queueLimit 4)",
	"/delegate set-project <field> <value>  set a knob in the project .pi/delegate/config.json overlay",
	"/delegate fg [general|research] <task...>   run in the FOREGROUND (blocks until done)",
	"/delegate research <task...>        research-role shorthand",
	"/delegate <task...>                 general-role shorthand",
	"flags (run/research/<task>): --timeout <90s|10m|2h|1d|ms> --background --foreground (mutually exclusive)",
	"timeout priority: per-invocation > project .pi/delegate/config.json > user ~/.pi/agent/delegate/config.json",
	"/delegate help                      this help",
].join("\n");

export const RESERVED_FIRST_TOKENS = new Set([
	"on",
	"off",
	"status",
	"paths",
	"doctor",
	"help",
	"cancel",
	"answer",
	"bg",
	"fg",
	"inspect",
	"resume",
	"peek",
	"run",
	"research",
	"set",
	"set-project",
]);

export interface ParseOptions {
	/** Recent run IDs offered for completion (newest first). */
	recentRunIds?: string[];
}

export function parseDelegateCommand(input: string, options: ParseOptions = {}): DelegateIntent {
	const trimmed = (input ?? "").trim();
	if (!trimmed) return { kind: "dashboard" };

	const first = trimmed.split(/\s+/)[0]!;
	if (!RESERVED_FIRST_TOKENS.has(first)) {
		// General-role shorthand. `research` is reserved, so a general task
		// that starts with that word must use `run general ...`.
		const { task, timeoutMs, execution } = extractFlags(trimmed);
		if (!task) return invalid(first);
		return { kind: "run", role: "general", task, explicit: false, timeoutMs, ...(execution ? { execution } : {}) };
	}

	switch (first) {
		case "on":
			return trimmed === "on" ? { kind: "enable" } : invalid("on");
		case "off":
			return trimmed === "off" ? { kind: "disable" } : invalid("off");
		case "status":
			return trimmed === "status" ? { kind: "status" } : invalid("status");
		case "paths":
			return trimmed === "paths" ? { kind: "paths" } : invalid("paths");
		case "doctor":
			return trimmed === "doctor" ? { kind: "doctor" } : invalid("doctor");
		case "help":
			return trimmed === "help" ? { kind: "help" } : invalid("help");
		case "cancel": {
			const rest = trimmed.slice("cancel".length).trim();
			return { kind: "cancel", runId: rest || undefined };
		}
		case "answer": {
			// R19: /delegate answer <run-id> <answer text...>
			const rest = trimmed.slice("answer".length).trim();
			const space = rest.indexOf(" ");
			if (space <= 0 || !rest.slice(space + 1).trim()) {
				return { kind: "invalid", token: "answer", usage: "/delegate answer <run-id> <answer text…>" };
			}
			return { kind: "answer", runId: rest.slice(0, space), text: rest.slice(space + 1).trim() };
		}
		case "inspect": {
			const rest = trimmed.slice("inspect".length).trim();
			return { kind: "inspect", runId: rest || undefined };
		}
		case "peek": {
			const rest = trimmed.slice("peek".length).trim();
			return { kind: "peek", runId: rest || undefined };
		}
		case "resume": {
			const rest = trimmed.slice("resume".length).trim();
			if (!rest) return invalid("resume");
			const { task, timeoutMs, execution } = extractFlags(rest);
			const runId = task.split(/\s+/)[0] ?? "";
			const body = task.slice(runId.length).trim();
			if (!runId || !body) return invalid("resume");
			return { kind: "resume", runId, task: body, timeoutMs, ...(execution ? { execution } : {}) };
		}
		case "bg": {
			// R20: user-facing background launch — /delegate bg [general|research] <task>
			const rest = trimmed.slice("bg".length).trim();
			if (!rest) return invalid("bg");
			const { task, timeoutMs, execution } = extractFlags(rest);
			if (!task) return invalid("bg");
			const parts = task.split(/\s+/);
			const roleToken = parts[0]!;
			if (roleToken === "general" || roleToken === "research") {
				const body = parts.slice(1).join(" ").trim();
				if (!body) return invalid("bg");
				return { kind: "bg", role: roleToken, task: body, timeoutMs, ...(execution ? { execution } : {}) };
			}
			return { kind: "bg", role: "general", task, timeoutMs, ...(execution ? { execution } : {}) };
		}
		case "fg": {
			// R22: explicit foreground shorthand — mirrors `bg` (role prefix
			// optional, defaults to general), but means FOREGROUND.
			const rest = trimmed.slice("fg".length).trim();
			if (!rest) return invalid("fg");
			const { task, timeoutMs, execution } = extractFlags(rest);
			if (!task) return invalid("fg");
			const parts = task.split(/\s+/);
			const roleToken = parts[0]!;
			if (roleToken === "general" || roleToken === "research") {
				const body = parts.slice(1).join(" ").trim();
				if (!body) return invalid("fg");
				return { kind: "fg", role: roleToken, task: body, timeoutMs, ...(execution ? { execution } : {}) };
			}
			return { kind: "fg", role: "general", task, timeoutMs, ...(execution ? { execution } : {}) };
		}
		case "run": {
			const rest = trimmed.slice("run".length).trim();
			if (!rest) return invalid("run");
			const { task, timeoutMs, execution } = extractFlags(rest);
			const parts = task.split(/\s+/);
			const roleToken = parts[0]!;
			if (roleToken === "general" || roleToken === "research") {
				const body = parts.slice(1).join(" ").trim();
			if (!body) return invalid("run");
				return { kind: "run", role: roleToken, task: body, explicit: true, timeoutMs, ...(execution ? { execution } : {}) };
			}
			// `run <task...>` — role defaults to general. A flag error (e.g.
			// --background + --foreground) also lands here with an empty task.
			if (!task) return invalid("run");
			return { kind: "run", role: "general", task, explicit: true, timeoutMs, ...(execution ? { execution } : {}) };
		}
		case "research": {
			const rest = trimmed.slice("research".length).trim();
			if (!rest) return invalid("research");
			const { task, timeoutMs, execution } = extractFlags(rest);
			if (!task) return invalid("research");
			return { kind: "run", role: "research", task, explicit: true, timeoutMs, ...(execution ? { execution } : {}) };
		}
		case "set": {
			// Panel≡command parity: the advanced-config input rows dispatch
		// through patchConfig — `set` is their command twin. Field validation
		// is a runtime concern (the app method owns it), not grammar.
			const rest = trimmed.slice("set".length).trim();
			const field = rest.split(/\s+/)[0] ?? "";
			const value = rest.slice(field.length).trim();
			if (!field || !value) return { kind: "invalid", token: "set", usage: "/delegate set <field> <value>" };
			return { kind: "set", field, value };
		}
		case "set-project": {
			// Same shape as `set`, but targets the project overlay file.
			const rest = trimmed.slice("set-project".length).trim();
			const field = rest.split(/\s+/)[0] ?? "";
			const value = rest.slice(field.length).trim();
			if (!field || !value) return { kind: "invalid", token: "set-project", usage: "/delegate set-project <field> <value>" };
			return { kind: "set-project", field, value };
		}
	}
	return invalid(first);
}

function invalid(token: string): DelegateIntent {
	return { kind: "invalid", token, usage: DELEGATE_USAGE };
}

/** Argument completion: reserved subcommands, roles, then recent run IDs. */
export function delegateCompletions(prefix: string, recentRunIds: string[] = []): string[] {
	const words = (prefix ?? "").trimStart();
	const tokens = words.split(/\s+/);
	const base: string[] = ["on", "off", "status", "paths", "doctor", "help", "cancel ", "answer ", "bg ", "fg ", "inspect ", "resume ", "peek ", "run ", "research ", "set ", "set-project "];

	const matches: string[] = [];
	if (tokens.length <= 1) {
		const p = words;
		for (const value of base) {
			const head = value.trimEnd();
			if (head.startsWith(p) || value.startsWith(p)) matches.push(value);
		}
	} else if (tokens[0] === "run") {
		const p = tokens[1] ?? "";
		for (const role of ROLE_NAMES) {
			if (role.startsWith(p)) matches.push(`${role} `);
		}
	} else if (tokens[0] === "cancel" || tokens[0] === "inspect" || tokens[0] === "resume" || tokens[0] === "peek") {
		const p = tokens[1] ?? "";
		for (const id of recentRunIds) {
			if (id.startsWith(p)) matches.push(`${id} `);
		}
	}
	// De-duplicate, keep order, cap for the TUI (all primary verbs fit).
	return [...new Set(matches)].slice(0, 17);
}

/**
 * Pull `--timeout <duration>` flags out of a task string (any position).
 * Unknown flags are kept in the task text; a malformed duration yields a
 * stable error message.
 */
export function extractFlags(input: string): { task: string; timeoutMs?: number; execution?: "background" | "foreground"; error?: string } {
	const tokens = input.split(/\s+/).filter(Boolean);
	const kept: string[] = [];
	let timeoutMs: number | undefined;
	let execution: "background" | "foreground" | undefined;
	let bg = 0;
	let fg = 0;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t === "--timeout") {
			const value = tokens[i + 1];
			if (!value) return { task: "", error: "--timeout needs a value (e.g. --timeout 30m)" };
			try {
				const parsed = parseDuration(value);
				if (parsed === undefined) return { task: "", error: "--timeout needs a value (e.g. --timeout 30m)" };
				timeoutMs = parsed;
				i += 1;
			} catch (e) {
				return { task: "", error: (e as Error).message };
			}
			continue;
		}
		if (t === "--background") {
			bg += 1;
			execution = "background";
			continue;
		}
		if (t === "--foreground") {
			fg += 1;
			execution = "foreground";
			continue;
		}
		kept.push(t);
	}
	if (bg > 0 && fg > 0) {
		return { task: "", error: "--background and --foreground are mutually exclusive" };
	}
	return { task: kept.join(" "), timeoutMs, ...(execution ? { execution } : {}) };
}

/**
 * Validate a raw task: normalize line endings, reject blank input,
 * enforce the UTF-8 byte limit. Returns the normalized task or a stable
 * E_INVALID_TASK error message.
 */
export function validateTask(task: unknown, maxTaskBytes: number): string | { error: string } {
	if (typeof task !== "string") return { error: "task must be a non-empty string" };
	const normalized = task.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (!normalized) return { error: "task is blank" };
	const bytes = Buffer.byteLength(normalized, "utf8");
	if (bytes > maxTaskBytes) {
		return {
			error: `task exceeds the ${maxTaskBytes} byte limit (${bytes} bytes); split it into a smaller, self-contained task`,
		};
	}
	return normalized;
}
