/**
 * tool-card tests — the S5 model-path card (Slice 2 gate: per-state cards).
 * Captures the registered `delegate` tool through the real factory and drives
 * renderResult/renderCall with synthetic details, asserting neutral, never
 * bare-`error:` rendering for cancelled/timeout and canonical tokens.
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

async function loadTool() {
	let jitiPath: string;
	try {
		jitiPath = require_.resolve("jiti");
	} catch {
		jitiPath = require_.resolve("jiti", { paths: [path.join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent")] });
	}
	const jiti = (await import(jitiPath)) as { createJiti?: (m: string, o: unknown) => { import: (p: string) => Promise<unknown> }; default?: (m: string, o: unknown) => { import: (p: string) => Promise<unknown> } };
	const make = jiti.createJiti ?? jiti.default!;
	const jitiInst = make(import.meta.url, { interopDefault: true });
	const mod = (await jitiInst.import(path.join(here, "..", "index.ts"))) as { default: (pi: unknown) => void };
	let captured: { renderCall: (a: unknown, t: unknown) => { render?: (w: number) => string[] }; renderResult: (r: unknown, o: unknown, t: unknown) => { render?: (w: number) => string[] } } | undefined;
	const pi = {
		registerCommand: () => {},
		registerTool: (def: { name: string; renderCall: unknown; renderResult: unknown }) => {
			if (def.name === "delegate") captured = def as never;
		},
		on: () => {},
		registerMessageRenderer: () => {},
	};
	process.env.PI_DELEGATE_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-card-"));
	mod.default(pi);
	assert.ok(captured, "delegate tool captured");
	return captured!;
}

const theme = { fg: (_k: string, s: string) => s } as never;
const flat = (c: { render?: (w: number) => string[] }, w = 80): string => (c.render ? c.render(w).join("\n") : String(c));

function details(state: string, extra: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1, runId: "run-abcdef0123456789", role: "general", state,
		startedAt: "", finishedAt: "", durationMs: 41_000, model: "zai/glm-5.3",
		usage: { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0, cost: 0.42, contextTokens: 0, turns: 3 },
		outputBytes: 512, outputTruncated: false, transcriptPath: "/tmp/t.jsonl", stderrPath: "/tmp/e.txt",
		displayItems: [], ...extra,
	};
}

test("tool card: succeeded — done word, canonical tokens, cost, short model", async () => {
	const { renderResult } = await loadTool();
	const out = flat(renderResult({ details: details("succeeded"), content: [] }, {}, theme));
	assert.match(out, /✓ done/);
	assert.match(out, /↑1\.2k ↓567/);
	assert.match(out, /\$0\.42/);
	assert.match(out, /glm-5\.3/);
	assert.ok(!out.includes("zai/"), "provider prefix stripped");
});

test("tool card: cancelled — neutral, never bare error:", async () => {
	const { renderResult } = await loadTool();
	const out = flat(renderResult({ details: details("cancelled", { partialHandoff: "wrote tests/ parity\nran them" }), content: [{ text: "error: E_CANCELLED" }] }, {}, theme));
	assert.match(out, /⊘ cancelled/);
	assert.ok(!/^\s*error:/im.test(out), "never renders a bare `error:` line");
	assert.match(out, /wrote tests\/ parity/, "partial handoff tail shown");
});

test("tool card: timed_out_idle — warning word + partial handoff, not error:", async () => {
	const { renderResult } = await loadTool();
	const out = flat(renderResult({ details: details("timed_out_idle", { partialHandoff: "step 1 done", sessionPath: "/tmp/s.jsonl" }), content: [{ text: "error: E_TIMEOUT" }] }, {}, theme));
	assert.match(out, /timeout · idle/);
	assert.ok(!/^\s*error:/im.test(out), "timeout is not a bare error");
	assert.match(out, /step 1 done/);
});

test("tool card: timed_out_hard vs idle are distinguishable words", async () => {
	const { renderResult } = await loadTool();
	const hard = flat(renderResult({ details: details("timed_out_hard"), content: [] }, {}, theme));
	const idle = flat(renderResult({ details: details("timed_out_idle"), content: [] }, {}, theme));
	assert.match(hard, /timeout · hard/);
	assert.match(idle, /timeout · idle/);
});

test("tool card: failed — failed word + reason tail, informative not bare", async () => {
	const { renderResult } = await loadTool();
	const out = flat(renderResult({ details: details("failed"), content: [{ text: "E_PROVIDER_ERROR: upstream 500" }] }, {}, theme));
	assert.match(out, /✗ failed/);
	assert.match(out, /E_PROVIDER_ERROR/, "reason preserved");
});

test("tool card: renderCall shows identity + task", async () => {
	const { renderCall } = await loadTool();
	const out = flat(renderCall({ role: "research", task: "audit the auth module for token expiry bugs in the token handling path which is long", model: "zai/glm-5.3" }, theme));
	assert.match(out, /delegate/);
	assert.match(out, /research/);
	assert.match(out, /glm-5\.3/);
});
