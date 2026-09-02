/**
 * delegate — /delegate grammar and intents.
 *
 * Reserved subcommands are matched before the general-task fallback.
 * This module owns grammar only: no mutation, no rendering.
 */

import type { RoleName } from "./types.ts";
import { ROLE_NAMES } from "./types.ts";

export type DelegateIntent =
	| { kind: "dashboard" }
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "status" }
	| { kind: "paths" }
	| { kind: "doctor" }
	| { kind: "help" }
	| { kind: "cancel"; runId?: string }
	| { kind: "inspect"; runId?: string }
	| { kind: "run"; role: RoleName; task: string; explicit: boolean }
	| { kind: "invalid"; token: string; usage: string };

export const DELEGATE_USAGE = [
	"/delegate                          dashboard (TUI) or status (headless)",
	"/delegate on                        enable strict delegation mode",
	"/delegate off                       disable strict delegation mode",
	"/delegate status                    mode, active run, last run",
	"/delegate paths                     config and run-store paths",
	"/delegate doctor                    diagnostics (no LLM call)",
	"/delegate cancel [run-id]           cancel the active (or matching) run",
	"/delegate inspect [run-id]          show run metadata (defaults to latest)",
	"/delegate run <general|research> <task...>   run with an explicit role",
	"/delegate research <task...>        research-role shorthand",
	"/delegate <task...>                 general-role shorthand",
	"/delegate help                      this help",
].join("\n");

const RESERVED_FIRST_TOKENS = new Set([
	"on",
	"off",
	"status",
	"paths",
	"doctor",
	"help",
	"cancel",
	"inspect",
	"run",
	"research",
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
		return { kind: "run", role: "general", task: trimmed, explicit: false };
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
		case "inspect": {
			const rest = trimmed.slice("inspect".length).trim();
			return { kind: "inspect", runId: rest || undefined };
		}
		case "run": {
			const rest = trimmed.slice("run".length).trim();
			const parts = rest.split(/\s+/);
			if (!rest) return invalid("run");
			const roleToken = parts[0]!;
			if (roleToken === "general" || roleToken === "research") {
				const task = parts.slice(1).join(" ").trim();
				if (!task) return invalid("run");
				return { kind: "run", role: roleToken, task, explicit: true };
			}
			// `run <task...>` — role defaults to general.
			return { kind: "run", role: "general", task: rest, explicit: true };
		}
		case "research": {
			const task = trimmed.slice("research".length).trim();
			if (!task) return invalid("research");
			return { kind: "run", role: "research", task, explicit: true };
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
	const base: string[] = ["on", "off", "status", "paths", "doctor", "help", "cancel ", "inspect ", "run ", "research "];

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
	} else if (tokens[0] === "cancel" || tokens[0] === "inspect") {
		const p = tokens[1] ?? "";
		for (const id of recentRunIds) {
			if (id.startsWith(p)) matches.push(`${id} `);
		}
	}
	// De-duplicate, keep order, cap for the TUI.
	return [...new Set(matches)].slice(0, 10);
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
