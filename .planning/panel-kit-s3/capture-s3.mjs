/**
 * S3 capture (pi-panel-kit stage 1) — deterministic ANSI renders of the two
 * fixed-height views BEFORE and AFTER the panel-frame refactor (mechanism A:
 * fixed fixtures, deterministic ANSI theme, no model, no TUI).
 *
 * Renders RunningView + PeekView at widths 80/62 and converts to PNG via the
 * existing ui-redesign harness converter. Usage:
 *
 *   node --experimental-strip-types .planning/panel-kit-s3/capture-s3.mjs before
 *   node --experimental-strip-types .planning/panel-kit-s3/capture-s3.mjs after
 *
 * Gate: `cmp before-X@W.{ans,png} after-X@W.{ans,png}` must be byte-identical.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { RunningView } from "../../ui/running-view.ts";
import { PeekView } from "../../ui/peek-view.ts";

const tag = process.argv[2];
if (tag !== "before" && tag !== "after") {
	console.error("usage: capture-s3.mjs <before|after>");
	process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const toPng = path.resolve(here, "../ui-redesign-2026-09-04/capture/ansi_to_png.py");

// Deterministic ANSI theme (same SGR map as capture-deterministic.mjs).
const CODE = { accent: 36, success: 32, error: 31, warning: 33, muted: 90, dim: 90, text: 37 };
const theme = { fg: (kind, s) => `\x1b[${CODE[kind] ?? 37}m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const keybindings = { matches: () => false };

// Fixtures — busy running child (progress bar, in-flight tools, a >80-col
// feed line to exercise width clipping, 3 feed lines into a 4-row window so
// the blank pad shows) and a live peek overlay (14 lines into a 16-row
// window). All literals: renders are 100% reproducible.
const runningState = {
	runId: "run-abcdef0123456789",
	role: "general",
	model: "zai/glm-5.3",
	phase: "tool:bash",
	elapsedMs: 41_000,
	hardMs: 1_800_000,
	turns: 7,
	tokens: { input: 1234, output: 567 },
	openTools: ["bash", "edit index.ts"],
	feedLines: [
		"+3s ▶ bash npm test",
		"+41s ✓ bash npm test (38s)",
		`+52s ✎ ## Outcome — ${"long line ".repeat(9)}clipped at the width limit`,
	],
};

const peekLines = [];
for (let i = 0; i < 14; i++) {
	peekLines.push(`+${i * 3}s ${i % 3 === 0 ? "▶" : i % 3 === 1 ? "✓" : "·"} ${i % 2 ? "bash npm test" : "read src/index.ts"}`);
}
const peekState = {
	title: "abcdef0123456789 · general · glm-5.3 · running",
	summary: "~/.pi/agent/delegate/runs/run-abc/transcript.jsonl",
	lines: peekLines,
	live: true,
};

const shots = [
	["running", (w) => new RunningView({ theme, keybindings, state: () => runningState, done: () => {} }).render(w)],
	["peek", (w) => new PeekView({ theme, keybindings, state: () => peekState, done: () => {} }).render(w)],
];

for (const [name, render] of shots) {
	for (const w of [80, 62]) {
		const base = `${tag}-${name}@${w}`;
		const ansi = render(w).join("\n") + "\n";
		fs.writeFileSync(path.join(here, `${base}.ans`), ansi);
		const r = spawnSync("python3", [toPng, "--file", path.join(here, `${base}.ans`), path.join(here, `${base}.png`)], { stdio: "inherit" });
		if (r.status !== 0) throw new Error("png failed: " + base);
		console.log(`shot ${base}.png`);
	}
}
