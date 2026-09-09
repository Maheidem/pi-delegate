/**
 * delegate ask-channel unit tests — R17/R18: ask_parent validation, the
 * child-side tool's polling/timeout/caps (via seams), envelopes (byte-exact),
 * and BackgroundManager.onAsk/answer routing (question wakes, note never
 * wakes, answer file round-trip, run-terminal withdrawal).
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	ASK_FALLBACK_TEXT,
	MAX_NOTES_PER_RUN,
	validateAskSubmission,
	writeAskAnswerFile,
	registerAskParentTool,
} from "../ask.ts";
import {
	BackgroundManager,
	formatChildNoteEnvelope,
	formatChildQuestionEnvelope,
	CHILD_NOTE_TYPE,
	CHILD_QUESTION_TYPE,
	type BackgroundManagerPorts,
} from "../background.ts";
import type { BackgroundRunHandle, DelegateRunResult, RoleName, SessionEntryLike } from "../types.ts";

// ── fixtures (mirrors background.test.ts helpers, kept local) ──────────────

function successResult(runId: string): DelegateRunResult {
	return {
		ok: true,
		handoff: "## Outcome\ndone",
		details: {
			schemaVersion: 1,
			runId,
			role: "general",
			state: "succeeded",
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

function deferredHandle(runId: string, description = "validate ask channel"): {
	handle: BackgroundRunHandle;
	resolve: (res: DelegateRunResult) => void;
} {
	let resolveCompletion!: (res: DelegateRunResult) => void;
	const completion = new Promise<DelegateRunResult>((resolve) => {
		resolveCompletion = resolve;
	});
	const handle: BackgroundRunHandle = {
		runId,
		role: "general",
		description,
		cancel: () => {},
		completion,
	};
	return { handle, resolve: resolveCompletion };
}

function makePorts(max = 3): { ports: BackgroundManagerPorts; sent: Array<{ customType: string; options: { triggerTurn: boolean }; details: Record<string, unknown> }>; entries: unknown[] } {
	const sent: Array<{ customType: string; options: { triggerTurn: boolean }; details: Record<string, unknown> }> = [];
	const entries: unknown[] = [];
	const ports: BackgroundManagerPorts = {
		sendMessage: (message, options) => {
			sent.push({ customType: message.customType, options: { ...options }, details: { ...message.details } });
		},
		appendEntry: (_t, data) => {
			entries.push(data);
		},
		maxBackgroundRuns: () => max,
		formatRun: () => "x",
		readReceipt: () => null,
	};
	return { ports, sent, entries };
}

async function flush(times = 4): Promise<void> {
	for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── validation ─────────────────────────────────────────────────────────────

test("R17: ask validation accepts typed topics and rejects the rest", () => {
	assert.equal(validateAskSubmission({ kind: "question", topic: "blocked", text: "Which schema?" }).ok, true);
	assert.equal(validateAskSubmission({ kind: "note", topic: "risk", text: "Flaky test" }).ok, true);
	assert.equal(validateAskSubmission({ kind: "question", topic: "risk", text: "x" }).ok, false, "question topic must be a question topic");
	assert.equal(validateAskSubmission({ kind: "note", topic: "blocked", text: "x" }).ok, false, "note topic must be a note topic");
	assert.equal(validateAskSubmission({ kind: "urgent", topic: "blocked", text: "x" }).ok, false);
	assert.equal(validateAskSubmission({ kind: "question", topic: "blocked", text: "" }).ok, false);
	assert.equal(validateAskSubmission({ kind: "question", topic: "blocked", text: "x".repeat(2001) }).ok, false);
});

// ── envelopes (SPEC §5 byte-exact) ────────────────────────────────────────

test("R17: question envelope is byte-exact and names delegate_answer", () => {
	const text = formatChildQuestionEnvelope("del_a", "research", "Trace the login flow", "blocked", "Which database, prod or staging?");
	assert.equal(
		text,
		"[delegate background del_a · research · Trace the login flow: asks]\n" +
			"\n" +
			"A delegated child is blocked waiting for your answer (topic: blocked). Answer\n" +
			"with the delegate_answer tool: delegate_answer({ runId: \"del_a\", answer: \"…\" }).\n" +
			"Be terse and directive; the child resumes the moment your answer lands. Do not\n" +
			"narrate this exchange to the user unless it is material. If you cannot answer,\n" +
			"say so — the child proceeds with its best judgment after the ask budget expires.\n" +
			"\n" +
			"Which database, prod or staging?",
	);
});

test("R18: note envelope is byte-exact", () => {
	const text = formatChildNoteEnvelope("del_a", "general", "Run the suite", "risk", "Tests write to /tmp shared state.");
	assert.equal(
		text,
		"[delegate background del_a · general · Run the suite: note]\n" +
			"\n" +
			"A delegated child filed a non-blocking note (topic: risk). No answer is\n" +
			"expected or possible. Treat it as an internal work event.\n" +
			"\n" +
			"Tests write to /tmp shared state.",
	);
});

// ── manager routing ───────────────────────────────────────────────────────

test("R17/R18: onAsk question wakes, note never wakes; end withdraws pending", async () => {
	const { ports, sent } = makePorts();
	const manager = new BackgroundManager(ports);
	const d = deferredHandle("del_a");
	manager.register(d.handle);

	manager.onAsk({ runId: "del_a", phase: "start", kind: "note", topic: "risk", text: "fyi", toolCallId: "t1" });
	manager.onAsk({ runId: "del_a", phase: "start", kind: "question", topic: "blocked", text: "Which one?", toolCallId: "t2" });
	await flush();
	assert.equal(sent.length, 2);
	assert.equal(sent[0].customType, CHILD_NOTE_TYPE);
	assert.equal(sent[0].options.triggerTurn, false, "notes never wake");
	assert.equal(sent[1].customType, CHILD_QUESTION_TYPE);
	assert.equal(sent[1].options.triggerTurn, true, "questions wake");
	assert.equal(sent[1].details.toolCallId, "t2");
	assert.deepEqual(manager.pendingQuestions(), [{ runId: "del_a", topic: "blocked", askedAt: sent[1].details.askedAt as string ?? manager.pendingQuestions()[0].askedAt }].map((q) => ({ runId: q.runId, topic: q.topic, askedAt: q.askedAt })));

	manager.onAsk({ runId: "del_a", phase: "end", kind: "question", topic: "", text: "", toolCallId: "t2" });
	assert.equal(manager.pendingQuestions().length, 0, "end withdraws the pending ask");
});

test("R17: answer writes the file through the handle and clears pending", async () => {
	const askDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-ask-test-"));
	const { ports, sent } = makePorts();
	const manager = new BackgroundManager(ports);
	const d = deferredHandle("del_a");
	d.handle.writeAnswer = (toolCallId, payload) => writeAskAnswerFile(askDir, toolCallId, payload);
	manager.register(d.handle);
	manager.onAsk({ runId: "del_a", phase: "start", kind: "question", topic: "guidance", text: "A or B?", toolCallId: "t9" });

	const ok = manager.answer("del_a", "Use B.", "model");
	assert.deepEqual(ok, { ok: true });
	const written = JSON.parse(fs.readFileSync(path.join(askDir, "t9.json"), "utf8"));
	assert.equal(written.answer, "Use B.");
	assert.equal(written.answeredBy, "model");
	assert.equal(manager.pendingQuestions().length, 0);

	// No pending ask anymore → instructive failure.
	const again = manager.answer("del_a", "again", "model");
	assert.equal(again.ok, false);
	if (!again.ok) assert.match(again.error, /no pending question/);
	const unknown = manager.answer("del_zzz", "x", "model");
	assert.equal(unknown.ok, false);
	void sent;
});

test("R17: run terminalization withdraws pending asks implicitly (no answerable run)", async () => {
	const { ports } = makePorts();
	const manager = new BackgroundManager(ports);
	const d = deferredHandle("del_a");
	manager.register(d.handle);
	manager.onAsk({ runId: "del_a", phase: "start", kind: "question", topic: "blocked", text: "?", toolCallId: "t1" });
	d.resolve(successResult("del_a"));
	await flush();
	const late = manager.answer("del_a", "too late", "model");
	assert.equal(late.ok, false);
});

// ── child-side tool via seams ─────────────────────────────────────────────

function fakePi() {
	const tools: Array<{ name: string; execute: (id: string, params: unknown) => Promise<unknown> }> = [];
	return {
		tools,
		registerTool: (def: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => tools.push(def),
	};
}

test("R17: child question resolves when the answer file appears (seam)", async () => {
	const pi = fakePi();
	registerAskParentTool(pi as never, {
		timeoutMs: 5_000,
		maxQuestions: 5,
		sleep: () => new Promise<void>((r) => setTimeout(r, 1)),
		readAnswer: (id) => (id === "tc1" ? { answeredBy: "user", answer: "Go with staging." } : null),
	});
	const askTool = pi.tools.find((t) => t.name === "ask_parent")!;
	const result = (await askTool.execute("tc1", { kind: "question", topic: "blocked", text: "Which env?" })) as {
		content: Array<{ text: string }>;
		details: { askAnswered?: boolean };
	};
	assert.match(result.content[0].text, /\[parent answered · by user\]\nGo with staging\./);
	assert.equal(result.details.askAnswered, true);
});

test("R17: child question times out with the exact fallback text", async () => {
	const pi = fakePi();
	registerAskParentTool(pi as never, {
		timeoutMs: 30,
		maxQuestions: 5,
		sleep: () => new Promise<void>((r) => setTimeout(r, 5)),
		readAnswer: () => null,
	});
	const askTool = pi.tools.find((t) => t.name === "ask_parent")!;
	const result = (await askTool.execute("tc2", { kind: "question", topic: "guidance", text: "?" })) as {
		content: Array<{ text: string }>;
		details: { askTimedOut?: boolean };
	};
	assert.equal(result.content[0].text, ASK_FALLBACK_TEXT);
	assert.equal(result.details.askTimedOut, true);
});

test("R17/R18: caps enforced (questions budget, notes cap)", async () => {
	const pi = fakePi();
	registerAskParentTool(pi as never, {
		timeoutMs: 10,
		maxQuestions: 1,
		sleep: () => Promise.resolve(),
		readAnswer: () => ({ answeredBy: "model", answer: "ok" }),
	});
	const askTool = pi.tools.find((t) => t.name === "ask_parent")!;
	const first = (await askTool.execute("q1", { kind: "question", topic: "blocked", text: "?" })) as { isError?: boolean };
	assert.equal(first.isError, undefined, "first question allowed");
	for (let i = 2; i <= MAX_NOTES_PER_RUN + 2; i++) {
		const note = (await askTool.execute(`n${i}`, { kind: "note", topic: "risk", text: "x" })) as { isError?: boolean };
		if (i <= MAX_NOTES_PER_RUN + 1) assert.equal(note.isError, undefined, `note ${i - 1} allowed`);
		else assert.equal(note.isError, true, "note cap reached");
	}
	const second = (await askTool.execute("q2", { kind: "question", topic: "blocked", text: "?" })) as { isError?: boolean; content: Array<{ text: string }> };
	assert.equal(second.isError, true, "question budget exhausted");
	assert.match(second.content[0].text, /Question budget exhausted/);
});

test("R17: rejected submissions name every invalid field", async () => {
	const pi = fakePi();
	registerAskParentTool(pi as never, { timeoutMs: 10, maxQuestions: 5, sleep: () => Promise.resolve(), readAnswer: () => null });
	const askTool = pi.tools.find((t) => t.name === "ask_parent")!;
	const badKind = (await askTool.execute("t", { kind: "shout", topic: "nope", text: "" })) as { content: Array<{ text: string }>; isError?: boolean };
	assert.equal(badKind.isError, true);
	assert.match(badKind.content[0].text, /kind must be/);
	assert.match(badKind.content[0].text, /text is required/);
	const badTopic = (await askTool.execute("t", { kind: "question", topic: "nope", text: "?" })) as { content: Array<{ text: string }>; isError?: boolean };
	assert.equal(badTopic.isError, true);
	assert.match(badTopic.content[0].text, /question topic must be one of/);
});
