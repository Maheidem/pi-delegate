/**
 * running-view tests — the FIXED-HEIGHT render contract.
 *
 * The live panel mounts as an inline `ctx.ui.custom` component that replaces
 * the composer region. If its height changes between frames the previous
 * frame smears over the input bar (the bug this guards). So render() must
 * return exactly PANEL_ROWS rows for ANY state and ANY width, never a
 * border line whose color span breaks width math.
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import { RunningView, type RunningViewState, } from "../ui/running-view.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const theme: any = { fg: (_c: string, t: string) => t };
const keybindings: any = { matches: () => false };

function view(state: RunningViewState): RunningView {
	return new RunningView({ theme, keybindings, state: () => state, done: () => {} });
}

const base: RunningViewState = {
	runId: "r1",
	role: "general",
	phase: "running",
	elapsedMs: 1234,
	feedLines: [],
};

test("running-view: fixed 9 rows when empty and starting", () => {
	const lines = view(base).render(80);
	assert.equal(lines.length, 9);
	assert.ok(lines[0].includes("Delegating"));
	assert.ok(lines.some((l) => l.includes("esc/q")));
});

test("running-view: height does not change as the feed fills up", () => {
	const empty = view(base).render(80).length;
	const partial = view({ ...base, feedLines: ["+1s ▶ bash npm test"] }).render(80).length;
	const full = view({
		...base,
		openTools: ["bash"],
		hardMs: 600_000,
		turns: 7,
		tokens: { input: 12000, output: 3000 },
		feedLines: Array.from({ length: 40 }, (_, i) => `+${i}s event line number ${i}`),
	}).render(80).length;
	assert.equal(empty, 9);
	assert.equal(partial, 9);
	assert.equal(full, 9, "a busy feed must not grow the panel");
});

test("running-view: fixed height across narrow, medium, wide terminals", () => {
	for (const w of [20, 40, 62, 80, 120, 200]) {
		const lines = view({
			...base,
			openTools: ["bash", "edit", "read"],
			hardMs: 900_000,
			feedLines: ["x".repeat(400), "y", "z"],
		}).render(w);
		assert.equal(lines.length, 9, `height stable at width ${w}`);
		for (const l of lines) {
			assert.ok(visibleWidth(l) <= w, `no line wider than ${w} (got ${visibleWidth(l)})`);
		}
	}
});

test("running-view: armed cancel re-renders the confirm footer", () => {
	const v = view(base);
	v.handleInput("\x1b"); // esc — arms confirmation
	const lines = v.render(80);
	assert.ok(lines.some((l) => /CONFIRM/i.test(l)));
	assert.equal(lines.length, 9);
});
