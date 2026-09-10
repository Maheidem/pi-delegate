/**
 * delegate R23 unit tests — automatic progress reports: config defaults and
 * clamps, the envelope (byte-exact), the pure throttle decision, and
 * BackgroundManager.onProgress delivery (never wakes, no ledger writes).
 */
import test from "node:test";
import * as assert from "node:assert/strict";

import { DEFAULT_DELEGATE_CONFIG, normalizeConfig } from "../config.ts";
import {
	BackgroundManager,
	formatProgressEnvelope,
	progressDisplay,
	PROGRESS_TYPE,
	type BackgroundManagerPorts,
	type ProgressReport,
} from "../background.ts";
import { shouldEmitProgress, type ProgressReportConfig, type ProgressThrottleState } from "../runner.ts";
import type { BackgroundRunHandle, DelegateRunResult } from "../types.ts";

// ── config ────────────────────────────────────────────────────────────────

test("R23: progressReports defaults are on with the spec values", () => {
	assert.deepEqual(DEFAULT_DELEGATE_CONFIG.progressReports, {
		enabled: true,
		minToolMs: 60_000,
		intervalMs: 300_000,
		minGapMs: 120_000,
		maxPerRun: 6,
	});
});

test("R23: progressReports clamps out-of-range values", () => {
	const { config } = normalizeConfig({
		progressReports: { enabled: false, minToolMs: 1, intervalMs: 999_999_999, minGapMs: 0, maxPerRun: 999 },
	});
	assert.equal(config.progressReports.enabled, false);
	assert.equal(config.progressReports.minToolMs, 5_000);
	assert.equal(config.progressReports.intervalMs, 3_600_000);
	assert.equal(config.progressReports.minGapMs, 30_000);
	assert.equal(config.progressReports.maxPerRun, 20);
	// non-numeric / wrong-typed fields keep defaults
	const again = normalizeConfig({ progressReports: { minToolMs: "x", enabled: "yes" } });
	assert.equal(again.config.progressReports.minToolMs, 60_000);
	assert.equal(again.config.progressReports.enabled, true);
});

// ── envelope (SPEC §4 R23, byte-exact) ───────────────────────────────────

const SAMPLE: ProgressReport = {
	runId: "del_prog1",
	elapsedMs: 192_000,
	lastTool: { name: "bash", durationMs: 48_000 },
	inFlightTools: ["read"],
	tokens: { input: 12_000, output: 3_400 },
};

test("R23: progress envelope is byte-exact (H3 + one-line comment + ≤2 body lines)", () => {
	const text = formatProgressEnvelope("del_prog1", "general", "Fix the failing tests", SAMPLE);
	assert.equal(
		text,
		"### [delegate background del_prog1 · general · Fix the failing tests: progress]\n" +
			"\n" +
			"<!-- This is an intermediate progress report. The run is still working and needs no reply. Treat it as an internal work event. -->\n" +
			"\n" +
			"3m 12s elapsed · bash done (48s)\n" +
			"↑12k ↓3.4k · in flight: read",
	);
});

test("R23: envelope body stays within 2 lines without optional fields", () => {
	const text = formatProgressEnvelope("del_a", "research", "Trace the login flow", {
		runId: "del_a",
		elapsedMs: 5_000,
		inFlightTools: [],
		tokens: { input: 0, output: 0 },
	});
	const body = text.split("\n\n").slice(2).join("\n\n");
	assert.equal(body.split("\n").length, 2);
	assert.equal(body, "5s elapsed\n↑0 ↓0");
});

// ── throttle decision (pure) ──────────────────────────────────────────────

const CFG: ProgressReportConfig = { enabled: true, minToolMs: 60_000, intervalMs: 300_000, minGapMs: 120_000, maxPerRun: 6 };
const T0 = 1_000_000;

test("R23: shouldEmitProgress honors enabled, gap, cap, and heartbeat interval", () => {
	const fresh: ProgressThrottleState = { reportsSent: 0, lastReportAt: T0, startedMs: T0 };
	assert.equal(shouldEmitProgress(fresh, T0 + 5_000, CFG, "tool"), true, "first report has no gap requirement");
	assert.equal(shouldEmitProgress({ ...fresh, reportsSent: 1 }, T0 + 60_000, CFG, "tool"), false, "minGap not reached");
	assert.equal(shouldEmitProgress({ ...fresh, reportsSent: 1 }, T0 + 120_000, CFG, "tool"), true, "gap satisfied");
	assert.equal(shouldEmitProgress({ ...fresh, reportsSent: 6 }, T0 + 999_999, CFG, "tool"), false, "per-run cap");
	assert.equal(shouldEmitProgress(fresh, T0 + 5_000, { ...CFG, enabled: false }, "tool"), false, "disabled");
	// heartbeat needs intervalMs of elapsed since start
	assert.equal(shouldEmitProgress(fresh, T0 + 299_999, CFG, "heartbeat"), false);
	assert.equal(shouldEmitProgress(fresh, T0 + 300_000, CFG, "heartbeat"), true);
});

// ── manager delivery ──────────────────────────────────────────────────────

function makeManager(): { manager: BackgroundManager; sent: Array<{ customType: string; content: string; options: { triggerTurn: boolean }; details: Record<string, unknown> }>; entries: unknown[] } {
	const sent: Array<{ customType: string; content: string; options: { triggerTurn: boolean }; details: Record<string, unknown> }> = [];
	const entries: unknown[] = [];
	const ports: BackgroundManagerPorts = {
		sendMessage: (message, options) => {
			sent.push({ customType: message.customType, content: message.content, options: { ...options }, details: { ...message.details } });
		},
		appendEntry: (_t, data) => {
			entries.push(data);
		},
		maxBackgroundRuns: () => 3,
		formatRun: () => "x",
		readReceipt: () => null,
	};
	return { manager: new BackgroundManager(ports), sent, entries };
}

function liveHandle(runId: string): { handle: BackgroundRunHandle; resolve: (res: DelegateRunResult) => void } {
	let resolveCompletion!: (res: DelegateRunResult) => void;
	const completion = new Promise<DelegateRunResult>((resolve) => {
		resolveCompletion = resolve;
	});
	return {
		handle: { runId, role: "general", description: "Fix the failing tests", cancel: () => {}, completion },
		resolve: resolveCompletion,
	};
}

test("R23: onProgress delivers triggerTurn:false on the serialized tail, no ledger entries", async () => {
	const { manager, sent, entries } = makeManager();
	const d = liveHandle("del_prog1");
	manager.register(d.handle);
	const baselineEntries = entries.length; // register writes the created entry

	manager.onProgress(SAMPLE);
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));

	assert.equal(sent.length, 1);
	assert.equal(sent[0].customType, PROGRESS_TYPE);
	assert.equal(sent[0].options.triggerTurn, false, "progress never wakes the parent");
	assert.equal(sent[0].details.kind, "progress");
	assert.equal(sent[0].details.runId, "del_prog1");
	assert.equal(sent[0].details.elapsedMs, 192_000);
	assert.match(sent[0].content, /: progress\]/);
	assert.equal(entries.length, baselineEntries, "progress is fire-and-forget: no ledger writes");
});

test("R23: onProgress ignores unknown runs (no crash, no message)", async () => {
	const { manager, sent } = makeManager();
	manager.onProgress({ ...SAMPLE, runId: "del_nope" });
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(sent.length, 0);
});

// ── display ───────────────────────────────────────────────────────────────

test("R23: progressDisplay shows ● + short runId + progress, classification stripped", () => {
	const env = formatProgressEnvelope("del_abcdefghijklmnop", "general", "Fix the failing tests", SAMPLE);
	const out = progressDisplay(env, { runId: "del_abcdefghijklmnop", description: "Fix the failing tests" });
	assert.ok(out.startsWith("● background "), "neutral ● glyph header");
	assert.match(out, /^● background [a-z0-9]+ · Fix the failing tests: progress\n\n/);
	assert.ok(!out.includes("<!--"), "model-only classification comment is stripped");
	assert.match(out, /3m 12s elapsed/);
});
