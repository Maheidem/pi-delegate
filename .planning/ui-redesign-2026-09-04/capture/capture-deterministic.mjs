/**
 * capture-deterministic.mjs — deterministic visual evidence (GOAL-PROMPT §6A).
 *
 * Renders the REAL components (vendored SettingsPanel, RunningView, PeekView,
 * and the delegate tool's renderResult) with a scripted fake-state timeline and
 * a deterministic ANSI theme, emitting one PNG per required screen at widths
 * 80/62/20. No model, 100% reproducible: proves layout / tokens / color /
 * fixed-height / width-clipping independent of child output.
 *
 * Run:  node --experimental-strip-types capture/capture-deterministic.mjs
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const shots = path.join(root, "evidence/shots");
fs.mkdirSync(shots, { recursive: true });

// Deterministic ANSI theme: map theme color KINDS to SGR codes (no pi theme needed).
const CODE = { accent: 36, success: 32, error: 31, warning: 33, muted: 90, dim: 90, text: 37 };
const theme = { fg: (kind, s) => `\x1b[${CODE[kind] ?? 37}m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, underline: (s) => `\x1b[4m${s}\x1b[0m` };
const keybindings = { matches: () => false, matchesKey: () => false, getKeys: (b) => ({ "tui.select.up": ["↑"], "tui.select.down": ["↓"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["esc"] }[b] ?? []) };

// Fake `done` to capture a tool def through the real factory.
async function captureRenderers() {
	const mod = await import("../../../index.ts");
	let tool;
	const pi = {
		registerCommand: () => {},
		registerTool: (def) => { if (def.name === "delegate") tool = def; },
		on: () => {},
		registerMessageRenderer: () => {},
	};
	process.env.PI_DELEGATE_AGENT_DIR = fs.mkdtempSync(path.join("/tmp", "delegate-cap-"));
	mod.default(pi);
	return tool;
}

function png(name, ansi) {
	const ans = "/tmp/delcap-" + name + ".ans";
	fs.writeFileSync(ans, ansi.endsWith("\n") ? ansi : ansi + "\n");
	const r = spawnSync("python3", [path.join(here, "ansi_to_png.py"), "--file", ans, path.join(shots, name + ".png")], { stdio: "inherit" });
	if (r.status !== 0) throw new Error("png failed: " + name);
	console.log("shot " + name + ".png");
}
const render = (c, w) => c.render(w).join("\n");

// ── Home dashboard (vendored SettingsPanel) — representative snapshot ─────────
function homeSnapshot(active, live, last) {
	const g = stateGlyphWord(last ? last.state : null);
	return {
		title: "Delegation",
		summaryLines: [
			"Delegate v0.3.0 · mode normal",
			live ? "Active   glm-5.3 ● 41s / 30m" : "Idle     no active run",
			...(active && !live ? ["Queue    1 waiting (limit 3)"] : []),
			last ? `Last     research ${g.glyph} ${g.word} in ${last.dur}` : "",
		].filter(Boolean),
		sections: [
			...(live ? [{ title: "Live", rows: [
				{ key: "lp", label: "Phase", value: "tool:bash · glm-5.3", kind: "info", valueStyle: "accent" },
				{ key: "lq", label: "Progress", value: "█████████░░░░░░░░░░░░░░░ 37% of 30m hard", kind: "info" },
				{ key: "lt", label: "Tokens", value: "↑1.2k ↓567 · $0.42", kind: "info", valueStyle: "muted" },
				{ key: "li", label: "In flight", value: "bash", kind: "info" },
				{ key: "tl", label: "", value: "+38s ▶ bash npm test", kind: "info", valueStyle: "muted" },
			] }] : []),
			{ title: "Actions", rows: [
				{ key: "run-general", label: "Run general task…", value: "", kind: "action" },
				{ key: "run-research", label: "Run research task…", value: "", kind: "action" },
				{ key: "peek", label: "Peek live / final detail", value: "", kind: "action", disabled: !active && !last },
				{ key: "cancel", label: "Cancel active run", value: "", kind: "action", disabled: !active },
				{ key: "resume", label: "Resume last run…", value: "", kind: "action", disabled: !last },
				{ key: "strict-toggle", label: "Enable strict mode", value: "", kind: "action" },
				{ key: "configure-advanced", label: "Configure advanced…", value: "›", kind: "action" },
				{ key: "doctor", label: "Doctor", value: "", kind: "action" },
				{ key: "paths", label: "Paths", value: "", kind: "action" },
			] },
			{ title: "Timeouts (base)", rows: [
				{ key: "cfg:user:hardTimeoutMs", label: "Hard · user-wide", value: "30m", rawValue: "1800000", kind: "input", inputHint: "e.g. 30m / 2h / 1d" },
				{ key: "cfg:user:inactivityTimeoutMs", label: "Idle · user-wide", value: "5m", rawValue: "300000", kind: "input", inputHint: "capped at ½ hard" },
				{ key: "cfg:project:hardTimeoutMs", label: "Hard · project", value: "not set", rawValue: "", kind: "input", inputHint: ".pi/delegate/config.json" },
			] },
		],
		shortcuts: [
			{ key: "r", label: "run", action: "run-general" },
			{ key: "p", label: "peek", action: "peek" },
			{ key: "x", label: "cancel", action: "cancel" },
			{ key: "c", label: "configure", action: "configure-advanced" },
			{ key: "d", label: "doctor", action: "doctor" },
		],
		detailLines: active ? ["live refresh 1s · enter selects"] : ["enter selects · edit a timeout"],
	};
}
function stateGlyphWord(s) {
	if (s === "succeeded") return { glyph: "✓", word: "done" };
	if (s === "cancelled") return { glyph: "⊘", word: "cancelled" };
	return { glyph: "✗", word: s || "unknown" };
}
function panel(name, snap) {
	const p = new SettingsPanel({ theme, keybindings, initialKey: "run-general", snapshot: () => snap, apply: () => null, activate: () => ({ kind: "none" }), requestRender: () => {}, done: () => {} });
	for (const w of [80]) png(name + "@80", render(p, w));
	png(name + "@62", render(p, 62));
	png(name + "@20", render(p, 20));
}


// RunningView + PeekView + vendored SettingsPanel via strip-types.
import { RunningView } from "../../../ui/running-view.ts";
import { PeekView } from "../../../ui/peek-view.ts";
import { SettingsPanel } from "../../../ui/settings-panel.ts";
import { feedEventsFromTranscript, renderFeedEvents } from "../../../transcript-feed.ts";

// S4 inline strip — fixed-height live component (real RunningView), fed by the
// REAL decode path (feedEventsFromTranscript → renderFeedEvents) so the shot
// proves the del_20260908T113930Z fix: a SUCCESSFUL read whose first text line
// contains `throw new Error(...)` renders ✓ (never ✗). Failure marks come only
// from authoritative status flags; the in-flight row is neutral/dim, not amber.
const stripT0 = Date.parse("2026-09-08T11:39:30.000Z");
const stripRec = (seq, sec, rec) => ({
	schemaVersion: 1,
	sequence: seq,
	receivedAt: new Date(stripT0 + sec * 1000).toISOString(),
	stream: "stdout",
	raw: JSON.stringify(rec),
});
const stripTranscript = "/tmp/delcap-strip-transcript.jsonl";
fs.writeFileSync(
	stripTranscript,
	[
		stripRec(0, 6, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "config.ts" } }),
		stripRec(1, 9, { type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false, result: { content: [{ type: "text", text: "export const PANEL_ROWS = 9;" }] } }),
		// Authoritative failure (top-level isError) — the ONLY ✗ in the strip.
		stripRec(2, 24, { type: "tool_execution_start", toolCallId: "b", toolName: "edit", args: { path: "index.ts" } }),
		stripRec(3, 27, { type: "tool_execution_end", toolCallId: "b", toolName: "edit", isError: true, result: { content: [{ type: "text", text: "oldText not found in file" }] } }),
		// Cautionary instance (del_20260908T113930Z): a SUCCESSFUL read whose
		// first line contains `throw new Error(...)` — must render ✓, never ✗.
		stripRec(4, 31, { type: "tool_execution_start", toolCallId: "c", toolName: "read", args: { path: "runner.ts" } }),
		stripRec(5, 34, { type: "tool_execution_end", toolCallId: "c", toolName: "read", isError: false, result: { content: [{ type: "text", text: 'throw new Error("parent did not reach idle")\nconst idle = true;' }] } }),
		stripRec(6, 38, { type: "tool_execution_start", toolCallId: "d", toolName: "bash", args: { command: "npm test" } }),
	].map((r) => JSON.stringify(r)).join("\n"),
);
const stripFeed = feedEventsFromTranscript(stripTranscript);
const runningState = {
	runId: "run-abcdef012345", role: "general", model: "zai/glm-5.3", phase: "tool:bash",
	elapsedMs: 41000, hardMs: 1800000, turns: 7, tokens: { input: 1234, output: 567 },
	openTools: ["bash"], feedLines: renderFeedEvents(stripFeed.events, { startMs: stripFeed.startMs }),
};
for (const w of [80, 62]) png("S4-inline-strip@" + w, render(new RunningView({ theme, keybindings, state: () => runningState, done: () => {} }), w));
png("S4-inline-strip@20", render(new RunningView({ theme, keybindings, state: () => ({ ...runningState, feedLines: [] }), done: () => {} }), 20));

// S6 peek — fixed-height overlay (real PeekView)

const peekLines = [];
for (let i = 0; i < 14; i++) peekLines.push(`+${i * 3}s ${i % 3 === 0 ? "▶" : i % 3 === 1 ? "✓" : "·"} ${i % 2 ? "bash npm test" : "read src/index.ts"}`);
png("S6-peek", render(new PeekView({ theme, keybindings, state: () => ({ title: "abcdef0123456789 · general · glm-5.3 · running", summary: "~/.pi/agent/delegate/runs/run-abc/transcript.jsonl", lines: peekLines, live: true }), done: () => {} }), 80));

// Home (idle + live) + Advanced — vendored SettingsPanel
panel("S1-home", homeSnapshot(false, false, { state: "succeeded", dur: "3m22s" }));
panel("S2-home-live", homeSnapshot(true, true, { state: "succeeded", dur: "3m22s" }));
panel("S7-advanced", {
	title: "Advanced configuration",
	summaryLines: ["User-wide · ~/.pi/agent/delegate/config.json", "Esc returns to Delegation"],
	sections: [{ title: "Knobs", rows: [
		{ key: "cfg:user:queueLimit", label: "Queue limit", value: "3", rawValue: "3", kind: "input", inputHint: "concurrent calls (1–10)" },
		{ key: "cfg:user:stuckToolTimeoutMs", label: "Stuck-tool watchdog", value: "hard (default)", rawValue: "", kind: "input", inputHint: "blank = inherit hard" },
		{ key: "cfg:user:killGraceMs", label: "Kill grace", value: "5s", rawValue: "5000", kind: "input", inputHint: "SIGTERM→SIGKILL" },
		{ key: "cfg:user:handoffGraceMs", label: "Handoff grace", value: "1m 30s", rawValue: "90000", kind: "input" },
		{ key: "cfg:user:handoffEnforceTimeoutMs", label: "Handoff enforce", value: "1m", rawValue: "60000", kind: "input" },
		{ key: "cfg:user:maxTaskBytes", label: "Max task bytes", value: "32768", rawValue: "32768", kind: "input" },
		{ key: "info:defaultRole", label: "Default role", value: "general", kind: "info" },
	] }],
});

// Tool-path cards (real renderResult)
const tool = await captureRenderers();
png("toolpath-done", render(tool.renderResult({ details: { runId: "run-abcdef0123456789", role: "general", state: "succeeded", durationMs: 41000, model: "zai/glm-5.3", usage: { input: 1234, output: 567, cost: 0.42 }, transcriptPath: "/tmp/t.jsonl", outputTruncated: false }, content: [] }, {}, theme), 80));
png("toolpath-cancelled", render(tool.renderResult({ details: { runId: "run-abcdef0123456789", role: "research", state: "cancelled", durationMs: 8000, model: "zai/glm-5.3", usage: { input: 400, output: 120, cost: 0.09 }, partialHandoff: "partial: wrote parity test\nran it", transcriptPath: "/tmp/t.jsonl", outputTruncated: false, sessionPath: "/tmp/s.jsonl" }, content: [{ text: "error: E_CANCELLED" }] }, {}, theme), 80));
png("toolpath-during", render(new RunningView({ theme, keybindings, state: () => ({ ...runningState, openTools: ["edit index.ts"] }), done: () => {} }), 80));

// S8 cancel-confirm — faithful confirmation dialog (destructive gate).
function confirmBox(title, body) {
	const w = 78;
	const boxLine = (s) => `\x1b[36m│\x1b[0m ${truncate(s, w - 5)} `;
	const top = `\x1b[36m╭${"─".repeat(w - 2)}╮\x1b[0m`;
	const bot = `\x1b[36m╰${"─".repeat(w - 2)}╯\x1b[0m`;
	return [top, boxLine(`\x1b[1m${title}\x1b[0m`), boxLine(`\x1b[90m${body}\x1b[0m`), boxLine(`\x1b[33m► Yes, cancel\x1b[0m    No`), bot].join("\n");
}
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
// pad title/body short lines to inner width so the box stays rectangular
function padBox(lines) { const inner = 73; return lines.map((l) => l.replace(/(│\x1b\[0m ?)(.*?)( ?│)/, (m, a, b, c) => a + b + " ".repeat(Math.max(0, inner - vis(b))) + c)); }
function vis(s) { return s.replace(/\x1b\[[0-9;]*m/g, "").length; }
const confirm = [
	"\x1b[36m╭" + "─".repeat(76) + "╮\x1b[0m",
	"\x1b[36m│\x1b[0m \x1b[1mCancel active run?\x1b[0m\x1b[90m" + " ".repeat(56) + "\x1b[36m│\x1b[0m",
	"\x1b[36m│\x1b[0m \x1b[90mSIGTERM then SIGKILL; a partial handoff is returned if the child produced one.\x1b[36m│\x1b[0m",
	"\x1b[36m│\x1b[0m \x1b[33m► Yes, cancel\x1b[0m        No\x1b[90m" + " ".repeat(48) + "\x1b[36m│\x1b[0m",
	"\x1b[36m╰" + "─".repeat(76) + "╯\x1b[0m",
];
fs.writeFileSync("/tmp/dl-S8.ans", confirm.join("\n") + "\n");
spawnSync("python3", [path.join(here, "ansi_to_png.py"), "--file", "/tmp/dl-S8.ans", path.join(shots, "S8-cancel-confirm.png")], { stdio: "inherit" });
console.log("shot S8-cancel-confirm.png");

// S9 doctor / paths — report screens (faithful report layout, real token styling).
function reportScreen(lines) {
	return lines.join("\n");
}
const doctor = [
	"\x1b[36m╭─ Doctor \x1b[0m" + "─".repeat(68) + "\x1b[0m╮",
	"\x1b[90m╰" + "─".repeat(77) + "╯\x1b[0m",
	"",
	"\x1b[32m✓\x1b[0m node        v26.5.0",
	"\x1b[32m✓\x1b[0m child mode  off (parent is orchestrator)",
	"\x1b[32m✓\x1b[0m store       ~/.pi/agent/delegate/runs",
	"\x1b[32m✓\x1b[0m config      hard 30m · idle 5m · stuck-tool inherit",
	"\x1b[32m✓\x1b[0m model srv   http://127.0.0.1:8123 reachable",
	"\x1b[33m⚠\x1b[0m recent runs 1 timed_out_idle in last 20",
	"\x1b[32m✓\x1b[0m handoff     mandatory structured handoff active",
];
fs.writeFileSync("/tmp/dl-S9-doctor.ans", reportScreen(doctor) + "\n");
spawnSync("python3", [path.join(here, "ansi_to_png.py"), "--file", "/tmp/dl-S9-doctor.ans", path.join(shots, "S9-doctor.png")], { stdio: "inherit" });
console.log("shot S9-doctor.png");
const paths = [
	"\x1b[36m[delegate paths]\x1b[0m",
	"\x1b[90mconfig:  \x1b[0m~/.pi/agent/delegate/config.json",
	"\x1b[90mruns:    \x1b[0m~/.pi/agent/delegate/runs",
	"\x1b[90msessions:\x1b[0m ~/.pi/agent/delegate/runs/sessions",
	"\x1b[90mlast run:\x1b[0m ~/.pi/agent/delegate/runs/run-abcdef0123456789",
	"\x1b[90mtranscript:\x1b[0m ~/.pi/agent/delegate/runs/run-abcdef0123456789/transcript.jsonl",
];
fs.writeFileSync("/tmp/dl-S9-paths.ans", reportScreen(paths) + "\n");
spawnSync("python3", [path.join(here, "ansi_to_png.py"), "--file", "/tmp/dl-S9-paths.ans", path.join(shots, "S9-paths.png")], { stdio: "inherit" });
console.log("shot S9-paths.png");

// Animation frames for demo.gif: feed filling up over a live run (real RunningView).
const feedTimeline = [
	["+1s ▶ starting child"],
	["+1s ▶ starting child", "+5s ▶ read config.ts"],
	["+1s ▶ starting child", "+5s ▶ read config.ts", "+12s ✓ read (84ms)"],
	["+5s ▶ read config.ts", "+12s ✓ read (84ms)", "+20s ▶ edit index.ts"],
	["+12s ✓ read (84ms)", "+20s ▶ edit index.ts", "+31s ▶ bash npm test"],
	["+20s ▶ edit index.ts", "+31s ▶ bash npm test", "+40s ✓ bash (512ms)"],
	["+31s ▶ bash npm test", "+40s ✓ bash (512ms)", "+46s ✎ handoff"],
];
feedTimeline.forEach((feed, i) => {
	const st = { ...runningState, feedLines: feed, elapsedMs: 5000 + i * 7000, openTools: i < 6 ? ["bash"] : [] };
	png("demo-frame-" + String(i + 1).padStart(2, "0"), render(new RunningView({ theme, keybindings, state: () => st, done: () => {} }), 94));
});

console.log("done -> " + shots);
