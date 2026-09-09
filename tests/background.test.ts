/**
 * delegate background unit tests — R8–R13 core mechanism:
 * description validation, envelope text (byte-exact), ledger projection,
 * delivery dedup/idempotence, slot limits, generation guard, tree pause,
 * shutdown cancel, reconcile paths (re-send, orphan, foreign-live,
 * purged receipt), and runBackground validation passthrough.
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import {
	BackgroundManager,
	BACKGROUND_LEDGER_TYPE,
	BACKGROUND_RESULT_TYPE,
	backgroundResultDisplay,
	deriveBackgroundDescription,
	formatBackgroundDetailText,
	formatBackgroundInventoryText,
	formatBackgroundResultEnvelope,
	formatBackgroundStartedText,
	projectBackgroundRuns,
	receiptToRunResult,
	validateBackgroundDescription,
	wasResultDelivered,
	type BackgroundManagerPorts,
} from "../background.ts";
import { DelegateApplicationImpl } from "../application.ts";
import { DEFAULT_DELEGATE_CONFIG } from "../config.ts";
import type {
	BackgroundRunHandle,
	DelegateRunResult,
	RunMetadataV1,
	SessionEntryLike,
} from "../types.ts";

// ── fixtures ──────────────────────────────────────────────────────────────

function successResult(runId: string, state: DelegateRunResult["details"]["state"] = "succeeded"): DelegateRunResult {
	return {
		ok: state === "succeeded",
		handoff: "## Outcome\ndone",
		details: {
			schemaVersion: 1,
			runId,
			role: "general",
			state,
			startedAt: "2026-09-09T10:00:00.000Z",
			finishedAt: "2026-09-09T10:01:00.000Z",
			durationMs: 60_000,
			model: "test/model",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			outputBytes: 20,
			outputTruncated: false,
			transcriptPath: "/tmp/t.jsonl",
			stderrPath: "/tmp/e.log",
			displayItems: [],
		},
	};
}

interface Deferred {
	handle: BackgroundRunHandle;
	resolve: (res: DelegateRunResult) => void;
	cancelReason: string | null;
}

function deferredHandle(runId: string, description = "validate background core"): Deferred {
	let resolveCompletion!: (res: DelegateRunResult) => void;
	const completion = new Promise<DelegateRunResult>((resolve) => {
		resolveCompletion = resolve;
	});
	let cancelReason: string | null = null;
	const handle: BackgroundRunHandle = {
		runId,
		role: "general",
		description,
		cancel: (reason?: string) => {
			cancelReason = reason ?? "cancelled";
		},
		completion,
	};
	return { handle, resolve: resolveCompletion, cancelReason: null, get cancel() { return cancelReason; } } as Deferred;
}

interface Recorded {
	sent: Array<{ message: { customType: string; content: string; details: Record<string, unknown> }; options: { deliverAs: string; triggerTurn: boolean } }>;
	entries: Array<{ customType: string; data: unknown }>;
}

function makePorts(options?: {
	max?: number;
	receipts?: Map<string, RunMetadataV1>;
	isPidAlive?: (pid: number) => boolean;
}): { ports: BackgroundManagerPorts; recorded: Recorded } {
	const recorded: Recorded = { sent: [], entries: [] };
	const receipts = options?.receipts ?? new Map<string, RunMetadataV1>();
	const ports: BackgroundManagerPorts = {
		sendMessage: (message, options_) => {
			recorded.sent.push({ message: { ...message, details: { ...message.details } }, options: { ...options_ } });
		},
		appendEntry: (customType, data) => {
			recorded.entries.push({ customType, data });
		},
		maxBackgroundRuns: () => options?.max ?? 3,
		formatRun: (res) => `[rendered ${res.details.runId} ${res.details.state}]`,
		readReceipt: (runId) => receipts.get(runId) ?? null,
		...(options?.isPidAlive ? { isPidAlive: options.isPidAlive } : {}),
	};
	return { ports, recorded };
}

/** Flush the serialized delivery tail (microtask chain + one macrotask). */
async function flush(times = 4): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function ledgerEntry(entry: unknown): SessionEntryLike {
	return { type: "custom", customType: BACKGROUND_LEDGER_TYPE, data: entry };
}

function deliveredEntry(runId: string): SessionEntryLike {
	return { type: "custom_message", customType: BACKGROUND_RESULT_TYPE, details: { runId, kind: "result" } };
}

function receipt(runId: string, state: RunMetadataV1["state"], pid?: number): RunMetadataV1 {
	return {
		schemaVersion: 1,
		runId,
		state,
		role: "general",
		source: "tool",
		cwd: "/tmp",
		task: "t",
		taskSha256: "0".repeat(64),
		model: "test/model",
		createdAt: "2026-09-09T10:00:00.000Z",
		startedAt: "2026-09-09T10:00:00.000Z",
		finishedAt: state === "created" || state === "starting" || state === "running" ? undefined : "2026-09-09T10:01:00.000Z",
		...(pid !== undefined ? { pid } : {}),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		transcriptPath: "/tmp/t.jsonl",
		stderrPath: "/tmp/e.log",
		background: true,
		description: "validate background core",
	} as RunMetadataV1;
}

// ── R8: description validation ────────────────────────────────────────────

test("R8: background description accepts 3–6 words, trims, rejects controls", () => {
	assert.deepEqual(validateBackgroundDescription("  Run full test matrix  "), { ok: true, value: "Run full test matrix" });
	assert.equal(validateBackgroundDescription("check the thing now").ok, true);
	assert.equal(validateBackgroundDescription("a b c d e f").ok, true);
	for (const bad of ["too short", "a b", "one two three four five six seven", "", "   "]) {
		assert.equal(validateBackgroundDescription(bad).ok, false, `expected reject: ${JSON.stringify(bad)}`);
	}
	assert.equal(validateBackgroundDescription("line\u2028break").ok, false);
	assert.equal(validateBackgroundDescription("null\u0000byte").ok, false);
	assert.equal(validateBackgroundDescription(42).ok, false);
});

test("R20: deriveBackgroundDescription builds a 3–6-word description from the task's first line", () => {
	assert.deepEqual(deriveBackgroundDescription("Write the report now please"), { ok: true, value: "Write the report now please" });
	// A long first line yields only its first 6 words.
	assert.deepEqual(
		deriveBackgroundDescription("one two three four five six seven eight nine ten"),
		{ ok: true, value: "one two three four five six" },
	);
	// Too few words to derive from.
	assert.equal(deriveBackgroundDescription("two words").ok, false);
	// Edge punctuation is stripped per word.
	assert.deepEqual(deriveBackgroundDescription("Fix: the, broken! test?"), { ok: true, value: "Fix the broken test" });
	// Control characters are replaced, not rejected.
	assert.deepEqual(deriveBackgroundDescription("Fix\u0000 the broken thing now"), { ok: true, value: "Fix the broken thing now" });
});

// ── R10: envelope text (byte-exact, SPEC §5) ─────────────────────────────

test("R10: terminal result envelope is byte-exact", () => {
	const text = formatBackgroundResultEnvelope(
		"del_20260909T000000Z_00000001",
		"research",
		"Trace login validation",
		"timed_out_hard",
		"[rendered body]",
	);
	assert.equal(
		text,
		"[delegate background del_20260909T000000Z_00000001 · research · Trace login validation: timed out_hard]\n" +
			"\n" +
			"This is the terminal report of a background delegation. The run has finished and\n" +
			"cannot receive steering. Treat it as an internal work event: write user-visible\n" +
			"text only if material, and do not re-narrate the handoff.\n" +
			"\n" +
			"[rendered body]",
	);
});

test("R8: started text names the run and instructs polling", () => {
	const text = formatBackgroundStartedText("del_x", "general", "Run the tests");
	assert.ok(text.startsWith("[delegate background started · del_x · general · Run the tests]"));
	assert.ok(text.includes("delegate_status"));
	assert.ok(text.includes("do not wait inline"));
});

test("R10: state words map terminal states", () => {
	assert.equal(formatBackgroundResultEnvelope("r", "general", "d d d", "succeeded", "x").includes(": completed]"), true);
	assert.equal(formatBackgroundResultEnvelope("r", "general", "d d d", "cancelled", "x").includes(": cancelled]"), true);
	// Foreground mapping verbatim (first-underscore replace), so the outer
	// header always agrees with the embedded formatRunText header.
	assert.equal(formatBackgroundResultEnvelope("r", "general", "d d d", "timed_out_idle", "x").includes(": timed out_idle]"), true);
	assert.equal(formatBackgroundResultEnvelope("r", "general", "d d d", "crashed", "x").includes(": crashed]"), true);
});

// ── R11: ledger projection ────────────────────────────────────────────────

test("R11: projection folds created/finished pairs, skips malformed and orphans", () => {
	const branch: SessionEntryLike[] = [
		ledgerEntry({ v: 1, type: "created", runId: "a", role: "general", description: "run a task", createdAt: "t1" }),
		ledgerEntry({ v: 1, type: "created", runId: "b", role: "research", description: "run b task", createdAt: "t2" }),
		{ type: "custom", customType: BACKGROUND_LEDGER_TYPE, data: { v: 1, type: "created", runId: "bad" } },
		{ type: "custom", customType: BACKGROUND_LEDGER_TYPE, data: "not-an-object" },
		ledgerEntry({ v: 1, type: "finished", runId: "a", state: "succeeded", finishedAt: "t3" }),
		ledgerEntry({ v: 1, type: "finished", runId: "zzz", state: "failed", finishedAt: "t4" }),
		{ type: "user" },
	];
	const { records, skipped } = projectBackgroundRuns(branch);
	assert.equal(records.size, 2);
	assert.equal(records.get("a")?.finished?.state, "succeeded");
	assert.equal(records.get("b")?.finished, undefined);
	assert.equal(skipped, 3);
});

test("R12: wasResultDelivered matches custom_message details by runId", () => {
	const branch = [deliveredEntry("a"), { type: "custom_message", customType: "other", details: { runId: "a" } }];
	assert.equal(wasResultDelivered(branch, "a"), true);
	assert.equal(wasResultDelivered(branch, "b"), false);
	assert.equal(wasResultDelivered([], "a"), false);
});

// ── R8/R10/R11: register → ledger created → terminal → finished + deliver ─

test("R8/R10/R11: happy path writes created, then finished before delivery", async () => {
	const { ports, recorded } = makePorts();
	const manager = new BackgroundManager(ports);
	const d = deferredHandle("del_a");
	manager.register(d.handle);
	assert.equal(recorded.entries.length, 1);
	assert.deepEqual(recorded.entries[0].data, {
		v: 1, type: "created", runId: "del_a", role: "general",
		description: "validate background core",
		createdAt: (recorded.entries[0].data as { createdAt: string }).createdAt,
	});
	assert.equal(recorded.sent.length, 0);
	d.resolve(successResult("del_a"));
	await flush();
	assert.equal(recorded.entries.length, 2);
	const finished = recorded.entries[1].data as { type: string; runId: string; state: string };
	assert.equal(finished.type, "finished");
	assert.equal(finished.runId, "del_a");
	assert.equal(finished.state, "succeeded");
	assert.equal(recorded.sent.length, 1);
	assert.equal(recorded.sent[0].message.customType, BACKGROUND_RESULT_TYPE);
	assert.deepEqual(recorded.sent[0].options, { deliverAs: "steer", triggerTurn: true });
	assert.deepEqual(recorded.sent[0].message.details, {
		runId: "del_a", role: "general", state: "succeeded",
		description: "validate background core", kind: "result",
	});
	assert.ok(recorded.sent[0].message.content.startsWith("[delegate background del_a · general · validate background core: completed]"));
});

// ── R9: slots ─────────────────────────────────────────────────────────────

test("R9: slot limit fails fast with E_BACKGROUND_FULL and frees on completion", async () => {
	const { ports, recorded } = makePorts({ max: 2 });
	const manager = new BackgroundManager(ports);
	const a = deferredHandle("del_a");
	const b = deferredHandle("del_b");
	const c = deferredHandle("del_c");
	manager.register(a.handle);
	manager.register(b.handle);
	const slot = manager.slotError();
	assert.ok(slot);
	assert.equal(slot!.code, "E_BACKGROUND_FULL");
	assert.match(slot!.message, /2 background runs active/);
	a.resolve(successResult("del_a"));
	await flush();
	assert.equal(manager.slotError(), null, "completion frees the slot");
	manager.register(c.handle);
	assert.ok(manager.slotError(), "c occupies the freed slot");
	b.resolve(successResult("del_b"));
	c.resolve(successResult("del_c"));
	await flush();
	assert.equal(manager.slotError(), null);
	// no double delivery for a
	assert.equal(recorded.sent.filter((s) => s.message.details.runId === "del_a").length, 1);
});

// ── R13: generation guard / session replacement ───────────────────────────

test("R13: stale completion after session replacement does not deliver; reconcile adopts live runs", async () => {
	const { ports, recorded } = makePorts();
	const manager = new BackgroundManager(ports);
	const d = deferredHandle("del_a");
	manager.register(d.handle);
	// Session replaced (start on a branch that does NOT own del_a).
	manager.start([]);
	d.resolve(successResult("del_a"));
	await flush();
	assert.equal(recorded.sent.length, 0, "stale generation must not deliver");
	assert.equal(recorded.entries.length, 1, "no finished entry from the stale path");
});

test("R13: run finishing while detached delivers on re-adopt (R12 reconcile)", async () => {
	const { ports, recorded } = makePorts({ receipts: new Map([["del_a", receipt("del_a", "succeeded", undefined)]]) });
	const manager = new BackgroundManager(ports);
	const d = deferredHandle("del_a");
	manager.register(d.handle);
	// Branch switch away, run finishes, switch back to the owning branch.
	manager.beforeTree();
	const branch = [ledgerEntry({ v: 1, type: "created", runId: "del_a", role: "general", description: "validate background core", createdAt: "t" })];
	manager.start([]); // replacement: detach
	d.resolve(successResult("del_a"));
	await flush();
	assert.equal(recorded.sent.length, 0);
	manager.afterTree(branch); // owning branch active again
	await flush();
	assert.equal(recorded.sent.length, 1, "reconcile delivers the undelivered terminal");
	assert.equal(recorded.sent[0].message.details.runId, "del_a");
	// Idempotent: second reconcile must not re-deliver.
	manager.afterTree([branch[0], deliveredEntry("del_a")]);
	await flush();
	assert.equal(recorded.sent.length, 1);
});

test("R13: tree pause buffers delivery until afterTree", async () => {
	const { ports, recorded } = makePorts();
	const manager = new BackgroundManager(ports);
	const d = deferredHandle("del_a");
	manager.register(d.handle);
	manager.beforeTree();
	d.resolve(successResult("del_a"));
	await flush();
	assert.equal(recorded.sent.length, 0, "paused: buffered");
	manager.afterTree([
		ledgerEntry({ v: 1, type: "created", runId: "del_a", role: "general", description: "validate background core", createdAt: "t" }),
	]);
	await flush();
	assert.equal(recorded.sent.length, 1, "flushed after tree switch");
});

test("R13: shutdown cancels every live run and blocks further delivery", async () => {
	const { ports, recorded } = makePorts();
	const manager = new BackgroundManager(ports);
	const a = deferredHandle("del_a");
	const b = deferredHandle("del_b");
	manager.register(a.handle);
	manager.register(b.handle);
	manager.shutdown();
	assert.equal(a.cancelReason ?? (a as unknown as { cancel: string }).cancel, "cancelled");
	assert.equal((b as unknown as { cancel: string }).cancel, "cancelled");
	a.resolve({ ...successResult("del_a"), details: { ...successResult("del_a").details, state: "cancelled" } });
	await flush();
	assert.equal(recorded.sent.length, 0, "post-shutdown generation blocks delivery");
});

// ── R12: reconcile paths ──────────────────────────────────────────────────

test("R12: finished-without-delivery re-sends exactly once from the receipt", async () => {
	const receipts = new Map([["del_a", receipt("del_a", "succeeded")]]);
	const { ports, recorded } = makePorts({ receipts });
	const manager = new BackgroundManager(ports);
	const branch = [
		ledgerEntry({ v: 1, type: "created", runId: "del_a", role: "general", description: "validate background core", createdAt: "t" }),
		ledgerEntry({ v: 1, type: "finished", runId: "del_a", state: "succeeded", finishedAt: "t2" }),
	];
	const first = manager.start(branch);
	assert.deepEqual(first.resent, ["del_a"]);
	await flush();
	assert.equal(recorded.sent.length, 1);
	// Restart again with the delivered message now on the branch: no dupe.
	const second = manager.start([...branch, deliveredEntry("del_a")]);
	assert.deepEqual(second.resent, []);
	await flush();
	assert.equal(recorded.sent.length, 1);
});

test("R12: nonterminal + dead pid is orphan-finalized then delivered (restart path)", async () => {
	const receipts = new Map([["del_a", receipt("del_a", "crashed", undefined)]]);
	// Simulate startup orphan marking between reconciles: first read shows
	// nonterminal with dead pid, second read (post-markOrphanedRuns) shows crashed.
	const states: Array<RunMetadataV1["state"]> = ["running", "crashed"];
	const { ports, recorded } = makePorts({
		receipts,
		isPidAlive: () => false,
	});
	(ports as { readReceipt: (id: string) => RunMetadataV1 | null }).readReceipt = (runId) => {
		const base = receipts.get(runId);
		if (!base) return null;
		return { ...base, state: states[0] };
	};
	const manager = new BackgroundManager(ports);
	const branch = [ledgerEntry({ v: 1, type: "created", runId: "del_a", role: "general", description: "validate background core", createdAt: "t" })];
	// First reconcile: nonterminal, pid dead -> re-read shows crashed (the
	// markOrphanedRuns stand-in) -> finished entry + delivery.
	states.shift();
	const { resent } = manager.start(branch);
	assert.deepEqual(resent, ["del_a"]);
	await flush();
	assert.equal(recorded.sent.length, 1);
	const finished = recorded.entries.at(-1)?.data as { type: string; state: string };
	assert.equal(finished.type, "finished");
	assert.equal(finished.state, "crashed");
});

test("R12: nonterminal + live foreign pid is reported, never touched", async () => {
	const receipts = new Map([["del_a", receipt("del_a", "running", 4242)]]);
	const { ports, recorded } = makePorts({ receipts, isPidAlive: () => true });
	const manager = new BackgroundManager(ports);
	const branch = [ledgerEntry({ v: 1, type: "created", runId: "del_a", role: "general", description: "validate background core", createdAt: "t" })];
	const { resent, notes } = manager.start(branch);
	assert.deepEqual(resent, []);
	assert.equal(notes.length, 1);
	assert.match(notes[0], /another live session \(pid 4242\)/);
	await flush();
	assert.equal(recorded.sent.length, 0);
	assert.equal(recorded.entries.filter((e) => (e.data as { type?: string }).type === "finished").length, 0);
});

test("R12: purged receipt on a finished entry is tolerated with a note", () => {
	const { ports } = makePorts({ receipts: new Map() });
	const manager = new BackgroundManager(ports);
	const branch = [
		ledgerEntry({ v: 1, type: "created", runId: "del_a", role: "general", description: "validate background core", createdAt: "t" }),
		ledgerEntry({ v: 1, type: "finished", runId: "del_a", state: "succeeded", finishedAt: "t2" }),
	];
	const { resent, notes } = manager.start(branch);
	assert.deepEqual(resent, []);
	assert.equal(notes.length, 1);
	assert.match(notes[0], /receipt purged/);
});

test("R12: malformed ledger entries never break reconcile", () => {
	const { ports } = makePorts();
	const manager = new BackgroundManager(ports);
	const { notes } = manager.start([
		{ type: "custom", customType: BACKGROUND_LEDGER_TYPE, data: { v: 9, type: "created" } },
		{ type: "custom", customType: BACKGROUND_LEDGER_TYPE, data: null },
	]);
	assert.match(notes[0], /malformed/);
});

// ── R8: runBackground validation passthrough (no spawn) ──────────────────

test("R8: runBackground returns validation errors without spawning", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-bg-test-"));
	const app = new DelegateApplicationImpl({ agentDir, config: { ...DEFAULT_DELEGATE_CONFIG } });
	const untrusted = app.runBackground({
		task: "do the thing now",
		role: "general",
		source: "tool",
		cwd: agentDir,
		parentModel: "",
		projectTrusted: false,
		background: true,
		description: "run the thing",
	});
	assert.equal("error" in untrusted, true);
	if (!("error" in untrusted)) return;
	assert.equal(untrusted.error.error?.code, "E_PROJECT_UNTRUSTED");
});

// ── R14/R15: status builders + display cleaning ─────────────────────

test("R16: send steers live runs, rejects done/unknown", async () => {
	const { ports } = makePorts();
	const manager = new BackgroundManager(ports);
	const sent: string[] = [];
	const a = deferredHandle("del_a");
	a.handle.steer = (message: string) => {
		sent.push(message);
		return { ok: true };
	};
	manager.register(a.handle);
	assert.deepEqual(manager.send("del_a", "prefer option two"), { ok: true });
	assert.deepEqual(sent, ["prefer option two"]);
	const unknown = manager.send("del_missing", "x");
	assert.equal(unknown.ok, false);
	if (!unknown.ok) assert.match(unknown.error, /unknown or expired background run/);
	a.resolve(successResult("del_a"));
	await flush();
	const done = manager.send("del_a", "x");
	assert.equal(done.ok, false);
	if (!done.ok) assert.match(done.error, /already finished/);
});

test("R14: inventory text lists slots, live runs, and recent terminals", () => {
	const text = formatBackgroundInventoryText({
		limit: 3,
		live: [
			{ runId: "del_a", role: "general", description: "run a task", phase: "tool:bash", elapsedMs: 45_000, openTools: ["bash"] },
			{ runId: "del_b", role: "research", description: "check the docs", detached: true },
		],
		queue: 1,
		recent: [{ runId: "del_z", role: "general", description: "old run", state: "succeeded", durationMs: 12_000 }],
	});
	assert.match(text, /background: 2\/3 slots active · queue 1/);
	assert.match(text, /del_a · general · run a task · tool:bash · 45s · ⏳ bash/);
	assert.match(text, /del_b · research · check the docs · \(branch inactive\)/);
	assert.match(text, /last: del_z general completed in 12s/);
});

test("R14: inventory with nothing live shows none", () => {
	const text = formatBackgroundInventoryText({ limit: 3, live: [], queue: 0, recent: [] });
	assert.match(text, /background: 0\/3 slots active/);
	assert.match(text, /· none/);
});

test("R14: detail text carries state, live phase, tail, and resume hint", () => {
	const text = formatBackgroundDetailText({
		runId: "del_a",
		role: "general",
		description: "run a task",
		state: "timed_out_hard",
		durationMs: 90_000,
		finishedAt: "2026-09-09T10:01:30.000Z",
		activityTail: ["+0s ▶ bash npm test", "+38s ✓ bash npm test"],
		handoffPreview: "## Outcome\npartial",
		sessionPath: "/tmp/s.jsonl",
		background: true,
	});
	assert.match(text, /state: timed out_hard/);
	assert.match(text, /duration: 90s/);
	assert.match(text, /recent activity:/);
	assert.match(text, /resume: delegate\(\{ resumeFrom: "del_a" \}\)/);
});

test("R15: display strips the model-only classification paragraph", () => {
	const content = formatBackgroundResultEnvelope("del_a", "general", "run a task", "succeeded", "[delegate v0.5 · header line]\n\nhandoff body line");
	const display = backgroundResultDisplay(content, { runId: "del_a", state: "succeeded", description: "run a task" });
	assert.match(display, /✓ background del_a · run a task: completed/);
	assert.ok(!display.includes("internal work event"), "model-only sentence never displayed");
	assert.match(display, /handoff body line/);
});

test("R15: display glyph+word per state (never color-alone)", () => {
	const cases: Array<[string, string]> = [
		["succeeded", "✓"],
		["failed", "⚠"],
		["crashed", "⚠"],
		["cancelled", "⊘"],
		["timed_out_idle", "⏱"],
		["timed_out_hard", "⏱"],
	];
	for (const [state, glyph] of cases) {
		const content = formatBackgroundResultEnvelope("r", "general", "d d d", state as never, "x");
		const display = backgroundResultDisplay(content, { runId: "r", state });
		assert.ok(display.startsWith(glyph), `${state} → ${glyph}`);
	}
});

test("R12: receiptToRunResult rebuilds a renderable result", () => {
	const meta = receipt("del_a", "timed_out_hard");
	meta.partialHandoff = "half done";
	meta.errorCode = "E_TIMEOUT_HARD";
	meta.errorMessage = "hard timeout";
	meta.finalHandoff = "";
	const res = receiptToRunResult(meta);
	assert.equal(res.details.state, "timed_out_hard");
	assert.equal(res.details.partialHandoff, "half done");
	assert.equal(res.error?.code, "E_TIMEOUT_HARD");
	assert.equal(res.ok, false);
});
