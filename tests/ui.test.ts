/**
 * delegate UI tests — width safety (80/62/20/1), selection preservation
 * across refresh, two-step cancellation confirmation, and theme/keybinding
 * injection through the component hosts (§12).
 */
import test from "node:test";
import * as assert from "node:assert/strict";

import { RunningView, type RunningViewState, type RunningViewHost } from "../ui/running-view.ts";
import { SettingsPanel, type PanelSnapshot, type PanelResult } from "../ui/settings-panel.ts";

// Theme fake: identity colors (ANSI-free so width math is exact).
const theme = {
	fg: (_kind: string, s: string) => s,
	bold: (s: string) => s,
} as never;
const keybindings = {
	matches: () => false,
	getKeys: (_action: string) => [] as string[],
} as never;

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const widths = [80, 62, 20, 1];

function runningState(): RunningViewState {
	return {
		runId: "del_20260901T000000Z_deadbeef",
		role: "general",
		model: "zai/glm-5.3",
		phase: "tool:bash",
		elapsedMs: 12_345,
		hardMs: 1_800_000,
		turns: 7,
		tokens: { input: 12_345, output: 3_456 },
		openTools: ["bash"],
		feedLines: [
			"+3s ▶ bash npm test",
			"+41s ✓ bash npm test (38s)",
			"+52s ✎ ## Outcome — matrix green",
		],
	};
}

test("ui: RunningView renders width-safe at 80/62/20/1", () => {
	for (const w of widths) {
		let doneCalled = false;
		const host: RunningViewHost = {
			theme,
			keybindings,
			state: runningState,
			done: () => {
				doneCalled = true;
			},
		};
		const view = new RunningView(host);
		const lines = view.render(w);
		assert.ok(lines.length >= 1, `width ${w}: must render at least one line`);
		for (const line of lines) {
			const len = Array.from(strip(line)).length;
			assert.ok(len <= Math.max(w, 8), `width ${w}: line overflows (${len}): ${JSON.stringify(line)}`);
		}
		assert.equal(doneCalled, false);
	}
	// At full width the feed is visible: identity, budgets, events.
	const lines80 = new RunningView({ theme, keybindings, state: runningState, done: () => {} }).render(80);
	const all80 = lines80.map(strip).join("\n");
	assert.ok(all80.includes("glm-5.3") && !all80.includes("zai/"), "model echoed (shortModel, provider prefix stripped)");
	assert.ok(all80.includes("turn 7"), "turn count echoed");
	assert.ok(all80.includes("npm test"), "feed events rendered");
	assert.ok(/% of 30m/.test(all80), "hard-cap progress rendered");
	assert.ok(all80.includes("in flight: bash"), "open tool rendered");
});

test("ui: RunningView requires two cancels before signalling", () => {
	let doneArg: { cancelled?: boolean } | undefined;
	const view = new RunningView({
		theme,
		keybindings,
		state: runningState,
		done: (r) => {
			doneArg = r;
		},
	});
	view.handleInput("\x1b"); // esc — arms confirmation
	assert.equal(doneArg, undefined);
	const armed = view.render(60).map(strip).join("\n");
	assert.match(armed, /CONFIRM/i);
	view.handleInput("\x1b"); // second esc — confirms
	assert.deepEqual(doneArg, { cancelled: true });
});

function snapshot(): PanelSnapshot {
	return {
		title: "delegate",
		summaryLines: [
			"mode           off",
			"active run     del_20260901T000000Z_deadbeef · running",
			"last run         general · done · 42s",
			"Default role     general",
		],
		sections: [
			{
				title: "Actions",
				rows: [
					{ key: "run-general", label: "Run general", value: "", kind: "action" },
					{ key: "run-research", label: "Run research", value: "", kind: "action" },
					{ key: "strict-toggle", label: "Enable strict mode", value: "", kind: "action" },
					{ key: "doctor", label: "Doctor", value: "", kind: "action" },
				],
			},
		],
	};
}

test("ui: SettingsPanel renders width-safe at 80/62/20/1", () => {
	for (const w of widths) {
		let doneArg: PanelResult | undefined;
		const panel = new SettingsPanel({
			theme,
			keybindings,
			snapshot,
			apply: () => null,
			activate: () => undefined,
			requestRender: () => {},
			done: (r) => {
				doneArg = r;
			},
		});
		const lines = panel.render(w);
		assert.ok(lines.length >= 1, `width ${w}`);
		for (const line of lines) {
			const len = Array.from(strip(line)).length;
			assert.ok(len <= Math.max(w, 12), `width ${w}: line overflows (${len}): ${JSON.stringify(line)}`);
		}
		assert.equal(doneArg, undefined);
	}
});

test("ui: selection preserved across refresh", () => {
	let renders = 0;
	const panel = new SettingsPanel({
		theme,
		keybindings,
		snapshot,
		apply: () => null,
		activate: () => undefined,
		requestRender: () => {
			renders += 1;
		},
		done: () => {},
	});
	// move down twice (j) using panel's raw-key fallback
	panel.handleInput("j");
	panel.handleInput("j");
	const before = panel.render(60).map(strip);
	panel.refresh();
	const after = panel.render(60).map(strip);
	const selBefore = before.findIndex((l) => /›/.test(l));
	const selAfter = after.findIndex((l) => /›/.test(l));
	assert.ok(selBefore >= 0, "selection marker present before refresh");
	assert.equal(selAfter, selBefore, "selection stays on same row after refresh");
	// and the selected row text is identical
	assert.equal(after[selAfter], before[selBefore]);
});

// ── PeekView ──────────────────────────────────────────────────────────────

import { PeekView } from "../ui/peek-view.ts";

test("ui: PeekView renders width-safe with live/final modes", () => {
	const linesOf = (live: boolean) => {
		const view = new PeekView({
			theme,
			keybindings,
			state: () => ({
				title: "del_…deadbeef · research · zai/glm-5.3 · running",
				summary: "/runs/del_x.jsonl",
				lines: Array.from({ length: 60 }, (_, i) => `+${i}s ▶ bash cmd-${i}`),
				live,
			}),
			done: () => {},
		});
		return view.render(80);
	};
	for (const live of [true, false]) {
		const lines = linesOf(live);
		for (const line of lines) {
			const len = Array.from(strip(line)).length;
			assert.ok(len <= 80, `live=${live}: overflow (${len})`);
		}
		const all = lines.map(strip).join("\n");
		assert.ok(all.includes("live — following") || all.includes("final —"), `live=${live}: mode label`);
		assert.ok(/\u2191\d/.test(all) || all.includes("no activity"), `live=${live}: bounded window with scroll hint`);
		assert.equal(lines.length, 20, `live=${live}: overlay fixed at 20 rows`);
		assert.ok(lines.length <= 26, `live=${live}: overlay stays in the panel budget`);
	}
});

test("ui: PeekView scrolling disables follow, f re-enables, q closes", () => {
	let doneArg: { closed?: boolean } | undefined;
	const state = () => ({
		title: "t",
		summary: "s",
		lines: Array.from({ length: 40 }, (_, i) => `event-${i}`),
		live: true,
	});
	const view = new PeekView({ theme, keybindings, state, done: (r) => (doneArg = r) });
	const before = view.render(80).map(strip).join("\n");
	view.handleInput("j"); // scroll up: follow off
	const after = view.render(80).map(strip).join("\n");
	assert.ok(after.includes("\u2193") || after !== before, "scroll moved the window");
	assert.equal(view.render(80).length, 20, "peek height fixed at 20");
	assert.equal(view.render(120).length, 20, "peek height stable at width 120");
	view.handleInput("f"); // follow again
	const refollowed = view.render(80).map(strip).join("\n");
	assert.ok(refollowed.includes("live — following"), "f re-enables follow");
	view.handleInput("q");
	assert.deepEqual(doneArg, { closed: true });
});

// ── transcript-feed formatting (Pi-free) ─────────────────────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FeedRing, feedEventsFromTranscript, renderFeedEvents } from "../transcript-feed.ts";

test("feed: renderFeedEvents stamps relative time and marks", () => {
	const start = Date.parse("2026-09-03T20:00:00Z");
	const lines = renderFeedEvents(
		[
			{ atMs: start + 3000, kind: "tool_start", tool: "bash", detail: "npm test" },
			{ atMs: start + 41_000, kind: "tool_end", tool: "bash", detail: "all green", durationMs: 38_000 },
			{ atMs: start + 52_000, kind: "tool_end", tool: "edit", detail: "boom", isError: true },
			{ atMs: start + 60_000, kind: "assistant", detail: "## Outcome — done" },
			{ atMs: start + 61_000, kind: "provider_error", detail: "usage limit reached" },
			{ atMs: start + 62_000, kind: "handoff", detail: "handoff submitted (done)" },
		],
		{ startMs: start },
	);
	assert.match(lines[0] ?? "", /\+3s ▶ bash npm test/);
	assert.match(lines[1] ?? "", /\+41s ✓ bash all green \(38s\)/);
	assert.match(lines[2] ?? "", /✗ edit boom/);
	assert.match(lines[3] ?? "", /✎ ## Outcome — done/);
	assert.match(lines[4] ?? "", /⚠ usage limit reached/);
	assert.match(lines[5] ?? "", /▣ handoff submitted \(done\)/);
});

test("feed: ring keeps a bounded window", () => {
	const ring = new FeedRing(5);
	for (let i = 0; i < 12; i++) ring.push({ atMs: i, kind: "info", detail: `e${i}` });
	assert.equal(ring.all().length, 5);
	assert.equal(ring.all()[0]?.detail, "e7");
});

test("feed: transcript decode → events (raw + base64 eras)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
	const file = path.join(dir, "t.jsonl");
	const t0 = "2026-09-03T20:00:00.000Z";
	const recs = [
		{ schemaVersion: 1, sequence: 0, receivedAt: t0, stream: "stdout", raw: JSON.stringify({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "npm test" } }) },
		{ schemaVersion: 1, sequence: 1, receivedAt: "2026-09-03T20:00:05.000Z", stream: "stdout", raw: JSON.stringify({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] } }) },
		// 0.1.0-era base64 envelope
		{ schemaVersion: 1, sequence: 2, receivedAt: "2026-09-03T20:00:07.000Z", stream: "stdout", rawBase64: Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Outcome\nsecond line" }], stopReason: "stop" } })).toString("base64") },
		{ schemaVersion: 1, sequence: 3, receivedAt: "2026-09-03T20:00:08.000Z", stream: "stdout", raw: JSON.stringify({ type: "agent_settled" }) },
	];
	fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n"));
	const { startMs, events } = feedEventsFromTranscript(file);
	assert.equal(events.length, 4);
	assert.equal(events[0]?.kind, "tool_start");
	assert.equal(events[0]?.detail, "npm test");
	assert.equal(events[1]?.kind, "tool_end");
	assert.equal(events[1]?.durationMs, 5000);
	assert.equal(events[2]?.kind, "assistant");
	assert.equal(events[2]?.detail, "## Outcome");
	assert.equal(events[3]?.kind, "settled");
	assert.ok(Number.isFinite(startMs));
	// missing file → empty feed, no throw
	const missing = feedEventsFromTranscript(path.join(dir, "nope.jsonl"));
	assert.equal(missing.events.length, 0);
});
test("feed: content that merely MENTIONS 'error' never renders as failure (del_20260908T113930Z)", () => {
	// Regression: the old heuristic /\berror\b/i on the result *head* flagged a
	// successful read of a source file as ✗ in the live feed. Failure now comes
	// from the AUTHORITATIVE status flags only — top-level `isError` (what Pi's
	// RPC actually emits), `result.isError`, or snake_case `is_error`.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-err-"));
	const file = path.join(dir, "t.jsonl");
	const t0 = Date.parse("2026-09-08T11:39:30.000Z");
	const mk = (seq: number, sec: number, rec: unknown) => ({
		schemaVersion: 1,
		sequence: seq,
		receivedAt: new Date(t0 + sec * 1000).toISOString(),
		stream: "stdout",
		raw: JSON.stringify(rec),
	});
	const recs = [
		mk(0, 0, { type: "tool_execution_start", toolCallId: "r1", toolName: "read", args: { path: "index.ts" } }),
		// SUCCESS whose first content line is `throw new Error(...)` — the reported false positive.
		mk(1, 1, {
			type: "tool_execution_end",
			toolCallId: "r1",
			toolName: "read",
			isError: false,
			result: { content: [{ type: "text", text: 'throw new Error("parent did not reach idle")\nmore source' }] },
		}),
		mk(2, 2, { type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "npm test" } }),
		mk(3, 3, { type: "tool_execution_end", toolCallId: "b1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "0 errors, 42 tests passed" }] } }),
		// GENUINE failures, carried the way Pi actually emits them (TOP level)…
		mk(4, 4, { type: "tool_execution_start", toolCallId: "b2", toolName: "bash", args: { command: "make" } }),
		mk(5, 5, { type: "tool_execution_end", toolCallId: "b2", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Command exited with code 2" }] } }),
		// …and in the other two accepted flag positions.
		mk(6, 6, { type: "tool_execution_end", toolCallId: "e1", toolName: "edit", result: { content: [{ type: "text", text: "oldText not found" }], isError: true } }),
		mk(7, 7, { type: "tool_execution_end", toolCallId: "e2", toolName: "grep", is_error: true, result: { content: [{ type: "text", text: "search failed" }] } }),
	];
	fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n"));

	const { startMs, events } = feedEventsFromTranscript(file);
	const end = (id: string) => events.find((e) => e.kind === "tool_end" && e.tool === id);

	assert.equal(end("read")?.isError, false, "read of a file containing Error() is NOT an error");
	assert.equal(end("bash")?.isError, false, "bash output mentioning '0 errors' is NOT an error");
	assert.equal(end("edit")?.isError, true, "result.isError is authoritative");
	assert.equal(end("grep")?.isError, true, "snake_case is_error is authoritative");
	// The genuine bash failure is the FIRST bash end (b1 succeeded at +3s, b2 failed at +5s).
	const bashEnds = events.filter((e) => e.kind === "tool_end" && e.tool === "bash");
	assert.deepEqual(bashEnds.map((e) => Boolean(e.isError)), [false, true], "bash: success then genuine failure");

	const lines = renderFeedEvents(events, { startMs });
	assert.ok(lines.some((l) => /^.*✓ read index\.ts/.test(l)), `successful read renders ✓ — got: ${lines.join(" | ")}`);
	assert.ok(lines.some((l) => /✓ bash 0 errors, 42 tests passed/.test(l)), "clean npm test renders ✓");
	assert.ok(!lines.some((l) => /✗/.test(l) && /index\.ts|0 errors/.test(l)), "no ✗ on successful calls");
	assert.ok(lines.some((l) => /✗ bash Command exited with code 2/.test(l)), "real failure renders ✗");
	assert.ok(lines.some((l) => /✗ edit oldText not found/.test(l)), "result.isError failure renders ✗");
	assert.ok(lines.some((l) => /✗ grep search failed/.test(l)), "snake_case failure renders ✗");
});
