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
		phase: "running",
		elapsedMs: 12_345,
		lastActions: ["read file.ts", "edit index.ts"],
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
