/** ui/format.ts — canonical formatters (reuse mandate, FIELDS §2/§3). */
import test from "node:test";
import * as assert from "node:assert/strict";
import { formatDuration, formatTokens, formatCost, formatSize, shortModel, stateGlyph, progressBar, projectValueCell } from "../ui/format.ts";

test("formatDuration delegates to config canonical", () => {
	assert.equal(formatDuration(0), "0ms");
	assert.match(formatDuration(41_000), /41s/);
	assert.match(formatDuration(1_800_000), /30m/);
});

test("formatTokens: 0 / raw / k / M", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(undefined), "0");
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(2_500_000), "2.5M");
});

test("formatCost: always $X.YZ", () => {
	assert.equal(formatCost(undefined), "$0.00");
	assert.equal(formatCost(0.125), "$0.13");
	assert.equal(formatCost(3), "$3.00");
});

test("formatSize: binary, 0–1 decimal", () => {
	assert.equal(formatSize(512), "512 B");
	assert.equal(formatSize(51200), "50 KB");
	assert.equal(formatSize(5 * 1024 * 1024), "5 MB");
});

test("shortModel: strips provider prefix", () => {
	assert.equal(shortModel("zai/glm-5.3"), "glm-5.3");
	assert.equal(shortModel("glm-5.3"), "glm-5.3");
	assert.equal(shortModel(undefined), "");
});

test("stateGlyph: never color-alone — always a distinct word", () => {
	const seen = new Set<string>();
	for (const s of ["running", "succeeded", "cancelled", "timed_out_idle", "timed_out_hard", "failed"]) {
		const g = stateGlyph(s);
		assert.ok(g.glyph.length && g.word.length, `${s} has glyph+word`);
		seen.add(g.word);
	}
	assert.ok(seen.has("cancelled") && seen.has("timeout · idle") && seen.has("timeout · hard"), "cancelled vs timeout states distinguished");
});

test("progressBar: bounded 0–1, includes percent text", () => {
	assert.match(progressBar(0, 10), /^░+ 0%$/);
	assert.match(progressBar(1, 10), /^█+ 100%$/);
	assert.match(progressBar(0.5, 10), /50%$/);
	assert.match(progressBar(5, 10), /100%$/, "clamped >1");
});

test("projectValueCell: file truth — equal-to-user gets a marker, absent is 'not set'", () => {
	// the display lie: project value present and EQUAL to user → visible, marked
	assert.equal(projectValueCell(7_200_000, 7_200_000), "2h (= user)");
	// differing project value → plain duration (unchanged rendering)
	assert.equal(projectValueCell(14_400_000, 7_200_000), "4h");
	assert.equal(projectValueCell(30_000, 7_200_000), "30s");
	// absent from the project file → the ONLY case that reads "not set"
	assert.equal(projectValueCell(undefined, 7_200_000), "not set");
	// non-finite guards (never "NaNh", never a false value)
	assert.equal(projectValueCell(Number.NaN, 7_200_000), "not set");
	assert.equal(projectValueCell(Number.POSITIVE_INFINITY, 7_200_000), "not set");
	assert.equal(projectValueCell(7_200_000, undefined), "2h");
});
