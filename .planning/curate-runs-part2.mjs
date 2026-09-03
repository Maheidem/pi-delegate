#!/usr/bin/env node
/**
 * One-time data repair part 2 (2026-09-03) — follow-up to curate-runs.mjs.
 *
 * 1. Adds the missing `finishedAt` to the 9 reconstructed receipts
 *    (part 1 dropped the field).
 * 2. Fills error codes/messages on the 8 receipts that finalized under 0.1.4
 *    without a payload (the "error: unknown failure" class, P3):
 *       - 2 reconstructed spawn failures: E_CHILD_EXIT (exact text from the
 *         parent session tool result).
 *       - 6 live receipts: code derived from the terminal state, message
 *         derived from the timeout config in effect at run time (verified
 *         against each run's wall duration in the plan doc).
 * Idempotent.
 */
import * as fs from "node:fs";
import { updateRunMetadata, readRunMetadata } from "../run-store.ts";

const AGENT_DIR = process.env.HOME + "/.pi/agent";
const gt = JSON.parse(fs.readFileSync("/tmp/curate/ground-truth.json", "utf8"));

// 1. finishedAt on the reconstructed 9
for (const [runId, o] of Object.entries(gt)) {
	const m = readRunMetadata(AGENT_DIR, runId);
	if (!m) continue;
	if (m.finishedAt === o.details.finishedAt) continue;
	updateRunMetadata(AGENT_DIR, runId, () => ({ finishedAt: o.details.finishedAt }));
	console.log(`finishedAt set: ${runId} -> ${o.details.finishedAt}`);
}

// 2. error payloads
const fixes = [
	{
		runId: "del_20260902T140723Z_a640c356",
		errorCode: "E_CHILD_EXIT",
		errorMessage: "Child exited before accepting the prompt (exit 1). ✖ 未知选项: --mode",
		note: "Curated 2026-09-03: error text taken verbatim from the parent session tool result; child was an older pi build that rejected --mode.",
	},
	{
		runId: "del_20260902T140741Z_55cb46e2",
		errorCode: "E_CHILD_EXIT",
		errorMessage: "Child exited before accepting the prompt (exit 1). ✖ 未知选项: --mode",
		note: "Curated 2026-09-03: error text taken verbatim from the parent session tool result; child was an older pi build that rejected --mode.",
	},
	{
		runId: "del_20260902T174738Z_e79dc2f2",
		errorCode: "E_TIMEOUT_IDLE",
		errorMessage: "no child activity for 5m (inactivity watchdog)",
		note: "Curated 2026-09-03: 0.1.4 carried no error payload (P3 — parent saw 'unknown failure'); code/message derived from terminal state and the 5m default inactivity in effect (wall 401s). Fixed in 0.1.5.",
	},
	{
		runId: "del_20260902T175428Z_32f1f033",
		errorCode: "E_TIMEOUT_IDLE",
		errorMessage: "no child activity for 5m (inactivity watchdog)",
		note: "Curated 2026-09-03: 0.1.4 carried no error payload (P3 — parent saw 'unknown failure'); code/message derived from terminal state and the 5m default inactivity in effect (wall 363s). Fixed in 0.1.5.",
	},
	{
		runId: "del_20260902T180159Z_981629f2",
		errorCode: "E_TIMEOUT_IDLE",
		errorMessage: "no child activity for 5m (inactivity watchdog)",
		note: "Curated 2026-09-03: 0.1.4 carried no error payload (P3 — parent saw 'unknown failure'); code/message derived from terminal state and the 5m default inactivity in effect (wall 378s). Fixed in 0.1.5.",
	},
	{
		runId: "del_20260902T185052Z_e3924d87",
		errorCode: "E_CANCELLED",
		errorMessage: "cancelled by user",
		note: "Curated 2026-09-03: 0.1.4 carried no error payload (P3 — parent saw 'unknown failure'); code derived from terminal state (user cancel via /delegate cancel, wall 33s). Fixed in 0.1.5.",
	},
	{
		runId: "del_20260903T004607Z_1238b870",
		errorCode: "E_TIMEOUT_IDLE",
		errorMessage: "no child activity for 22m 30s (inactivity watchdog)",
		note: "Curated 2026-09-03: 0.1.4 carried no error payload (P3 — parent saw 'unknown failure'); code/message derived from terminal state; effective inactivity = min(44m user, 45m project hard / 2 = 22m 30s cap) (wall 1458s). Fixed in 0.1.5.",
	},
	{
		runId: "del_20260903T023212Z_623d2b0a",
		errorCode: "E_TIMEOUT_HARD",
		errorMessage: "hard timeout of 45m reached (wall-clock cap)",
		note: "Curated 2026-09-03: 0.1.4 carried no error payload (P3 — parent saw 'unknown failure'); code/message derived from terminal state; project hard timeout 45m in effect (wall 2702s). Fixed in 0.1.5.",
	},
];
for (const f of fixes) {
	const before = readRunMetadata(AGENT_DIR, f.runId);
	if (!before) {
		console.log(`skip (missing): ${f.runId}`);
		continue;
	}
	if (before.errorCode === f.errorCode && before.curationNote) {
		console.log(`skip (done): ${f.runId}`);
		continue;
	}
	updateRunMetadata(AGENT_DIR, f.runId, () => ({
		errorCode: f.errorCode,
		errorMessage: f.errorMessage,
		curationNote: f.note,
	}));
	console.log(`error set: ${f.runId} -> ${f.errorCode}`);
}
console.log("done");
