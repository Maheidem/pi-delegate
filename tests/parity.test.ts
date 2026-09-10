/**
 * parity tests — Slice 0 governance contract (no behavior change).
 *
 * Enforces the FIELDS.md §5 parity table: every function is reachable from
 * the panel (action key), the nested command (verb), and headless stdout via
 * the SAME application method. Catches "the panel hides a command" drift —
 * the exact gap the redesign closes (status/peek/cancel/resume were commands
 * but had no panel row).
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import { parseDelegateCommand, delegateCompletions, RESERVED_FIRST_TOKENS as RESERVED } from "../commands.ts";
import { DelegateApplicationImpl } from "../application.ts";
import { DEFAULT_DELEGATE_CONFIG } from "../config.ts";

// The parity table (panel key ⇄ nested command ⇄ app method), per FIELDS §5.
const PARITY: Array<{ panelKey: string; verb: string; method: string }> = [
	{ panelKey: "run-general", verb: "run general", method: "run" },
	{ panelKey: "run-research", verb: "research", method: "run" },
	// R22: the "run-background" action row was removed (two role-based actions only);
	// the bg/fg verbs stay reachable as commands against runBackground/run.
	{ panelKey: "peek", verb: "peek", method: "inspect" },
	{ panelKey: "cancel", verb: "cancel", method: "cancel" },
	{ panelKey: "resume", verb: "resume", method: "run" },
	{ panelKey: "strict-toggle", verb: "on", method: "enableStrict" },
	{ panelKey: "inspect-last", verb: "inspect", method: "inspect" },
	{ panelKey: "doctor", verb: "doctor", method: "doctor" },
	{ panelKey: "paths", verb: "paths", method: "paths" },
];

test("parity: every nested verb parses to a non-invalid intent", () => {
	const verbs: Array<[string, string]> = [
		["status", "status"], ["paths", "paths"], ["doctor", "doctor"], ["help", "help"],
		["on", "enable"], ["off", "disable"], ["cancel", "cancel"], ["inspect", "inspect"],
		["peek", "peek"], ["resume r1 do it", "resume"], ["run general hi", "run"],
		["research hi", "run"], ["bg do the thing now", "bg"], ["fg do the thing now", "fg"],
	];
	for (const [input, kind] of verbs) {
		const intent = parseDelegateCommand(input);
		assert.equal(intent.kind, kind, `parse "${input}" → ${intent.kind}, want ${kind}`);
	}
});

test("parity: every panel action key has a command verb and an app method", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-parity-"));
	const app = new DelegateApplicationImpl({ agentDir: dir, config: DEFAULT_DELEGATE_CONFIG });
	for (const row of PARITY) {
		const verbHead = row.verb.split(/\s+/)[0]!;
		assert.ok(RESERVED.has(verbHead), `verb "${verbHead}" (for panel ${row.panelKey}) is reserved/parsed`);
		assert.equal(typeof (app as unknown as Record<string, unknown>)[row.method], "function", `app.${row.method} exists for panel ${row.panelKey}`);
	}
});

test("parity: completions offer every primary verb", () => {
	const done = delegateCompletions("").join(" ");
	for (const verb of ["status", "cancel", "inspect", "peek", "resume", "run", "research", "doctor", "paths", "on", "off", "help"]) {
		assert.ok(done.includes(verb), `completion lists "${verb}"`);
	}
});

test("parity: role completion under `run`", () => {
	const done = delegateCompletions("run ").join(" ");
	assert.ok(done.includes("general") && done.includes("research"), "run <role> completes roles");
});

test("completions: nested run-id under peek/cancel/resume/inspect (S11)", () => {
	const ids = ["run-abcdef0123", "run-9988776655"];
	for (const verb of ["peek", "cancel", "resume", "inspect"]) {
		const done = delegateCompletions(`${verb} `, ids).join(" ");
		assert.ok(done.includes("run-abcdef0123") && done.includes("run-9988776655"), `${verb} <run-id> completes recent runs`);
	}
	// prefix filtering
	assert.ok(delegateCompletions("peek run-ab", ids).join(" ").includes("run-abcdef0123"), "run-id prefix filters");
});
