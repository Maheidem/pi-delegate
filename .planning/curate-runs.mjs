#!/usr/bin/env node
/**
 * One-time data repair (2026-09-03) — curate delegate run receipts.
 *
 * 1. Reconstructs the 9 run receipts whose files were deleted by retention
 *    (maxRuns=50 count rule, 2026-09-03T03:40:59Z) from the PARENT SESSIONS'
 *    delegate tool results — the authoritative record of what the runner
 *    actually produced. Transcripts/stderr are unrecoverable (deleted).
 * 2. Corrects two live receipts with clobbered/missing error fields:
 *       - del_20260902T181850Z_9da48e0b: errorCode E_ORPHANED_RUN on a
 *         timed_out_hard run (orphan recovery raced the hard-timeout
 *         finalization 6 ms apart) → E_TIMEOUT_HARD.
 *       - del_20260902T230801Z_7c3c4a70: timed_out_idle with no error code
 *         (0.1.4 carried no payload — the parent saw "unknown failure")
 *         → E_TIMEOUT_IDLE.
 * Every repaired receipt carries a curationNote recording the event and the
 * source of truth. Idempotent: skips files that already exist / already carry
 * the corrected state.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { atomicWriteJson } from "../config.ts";
import { updateRunMetadata, readRunMetadata } from "../run-store.ts";

const AGENT_DIR = path.join(process.env.HOME ?? "", ".pi", "agent");
const RUNS_DIR = path.join(AGENT_DIR, "delegate", "runs");
const gt = JSON.parse(fs.readFileSync("/tmp/curate/ground-truth.json", "utf8"));

const CWD_BY_SESSION = {
	"2026-09-02T00-58-42": "/private/tmp/e2e-b/nSqrtQ",
	"2026-09-02T13-58-30": "/Users/maheidem/Documents/dev/pi-coder-management",
	"2026-09-02T17-18-47": "/Users/maheidem/Documents/dev/pi-coder-management",
};

const CLOBBERED = new Set([
	"del_20260902T171941Z_0d88351d", // clobbered 17:20:38Z by concurrent pi startup
	"del_20260902T173809Z_7f30d98c", // clobbered 17:46:35Z by concurrent pi startup
]);

let written = 0;
let skipped = 0;
for (const [runId, o] of Object.entries(gt)) {
	const metaPath = path.join(RUNS_DIR, `${runId}.json`);
	if (fs.existsSync(metaPath)) {
		skipped += 1;
		console.log(`skip (exists): ${runId}`);
		continue;
	}
	const d = o.details;
	const sessionDay = o.session.slice(0, 16);
	const notePrefix = CLOBBERED.has(runId)
		? `Original receipt was clobbered to crashed/E_ORPHANED_RUN by a concurrent pi startup (markOrphanedRuns had no PID liveness check — fixed in 0.1.5), `
		: "";
	const metadata = {
		schemaVersion: 1,
		runId,
		state: d.state,
		role: d.role ?? o.role ?? "general",
		source: "tool",
		cwd: CWD_BY_SESSION[sessionDay] ?? "/Users/maheidem/Documents/dev/pi-coder-management",
		task: o.task ?? "",
		taskSha256: crypto.createHash("sha256").update(o.task ?? "", "utf8").digest("hex"),
		model: d.model,
		...(d.thinkingLevel ? { thinkingLevel: d.thinkingLevel } : {}),
		createdAt: d.startedAt,
		startedAt: d.startedAt,
		...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
		...(d.stopReason ? { stopReason: d.stopReason } : {}),
		usage: d.usage,
		...(d.outputBytes !== undefined ? { outputBytes: d.outputBytes } : {}),
		outputTruncated: d.outputTruncated ?? false,
		...(d.state === "succeeded" && o.handoff ? { finalHandoff: o.handoff } : {}),
		transcriptPath: path.join(RUNS_DIR, `${runId}.jsonl`),
		stderrPath: path.join(RUNS_DIR, `${runId}.stderr.log`),
		curationNote:
			`Curated 2026-09-03: ${notePrefix}` +
			`receipt file (and transcript/stderr) deleted by retention (maxRuns=50 count rule) at 2026-09-03T03:40:59Z. ` +
			`Reconstructed from the parent session delegate tool result (session ${o.session}); ` +
			`transcript/stderr files unrecoverable. pid and thinkingLevel unknown.`,
	};
	atomicWriteJson(metaPath, metadata);
	written += 1;
	console.log(`reconstructed: ${runId} (${d.state})`);
}

// ── error-field corrections on live receipts ────────────────────────────
const corrections = [
	{
		runId: "del_20260902T181850Z_9da48e0b",
		errorCode: "E_TIMEOUT_HARD",
		errorMessage: "hard timeout of 30m reached (wall-clock cap)",
		note:
			"Curated 2026-09-03: error fields were clobbered by an orphan recovery that raced the hard-timeout finalization (6 ms apart, 2026-09-02T18:48:52Z) — errorCode showed E_ORPHANED_RUN on a timed_out_hard run. Corrected to E_TIMEOUT_HARD per the parent session tool result (state and duration agree). Fixed in 0.1.5 (PID liveness check in markOrphanedRuns).",
	},
	{
		runId: "del_20260902T230801Z_7c3c4a70",
		errorCode: "E_TIMEOUT_IDLE",
		errorMessage: "no child activity for 44m (inactivity watchdog)",
		note:
			"Curated 2026-09-03: 0.1.4 carried no error payload into timed_out_idle (P3 bug — the parent model saw 'error: unknown failure'). Set E_TIMEOUT_IDLE per the 44m inactivity watchdog then in effect (wall 2759s = 119s activity + 44m silence). Fixed in 0.1.5 (synthesized error payload in finish()).",
	},
];
for (const c of corrections) {
	const before = readRunMetadata(AGENT_DIR, c.runId);
	if (!before) {
		console.log(`skip (missing): ${c.runId}`);
		continue;
	}
	if (before.errorCode === c.errorCode && before.curationNote) {
		console.log(`skip (already curated): ${c.runId}`);
		continue;
	}
	const after = updateRunMetadata(AGENT_DIR, c.runId, () => ({
		errorCode: c.errorCode,
		errorMessage: c.errorMessage,
		curationNote: c.note,
	}));
	console.log(`corrected: ${c.runId} ${before.errorCode ?? "(none)"} -> ${after.errorCode}`);
}

console.log(`\ndone: ${written} reconstructed, ${skipped} skipped`);
