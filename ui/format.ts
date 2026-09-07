/**
 * delegate — shared formatting (reuse mandate, FIELDS.md §2).
 *
 * ONE module all views import so tokens/durations/sizes/model render
 * identically across home, live strip, inline tool card, and peek. Wraps the
 * canonical `formatDuration` (config.ts) rather than re-rolling it. Replaces
 * the duplicate `fmtDuration`/`fmtTokens` that used to live in running-view.
 */

import { formatDuration } from "../config.ts";

/** Canonical duration (ms → "41s"/"30m 22s"/"2h"). */
export { formatDuration };

/** Token count: 0 if falsy; raw <1000; else `X.Yk`; else `X.YM`. */
export function formatTokens(n: number | undefined): string {
	if (!n || n < 0) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
	return `${Math.round(n / 100_000) / 10}M`;
}

/** Cost as `$X.YZ` (2 dp) or `$0.00`. Never emoji. */
export function formatCost(cost: number | undefined): string {
	return `$${(cost ?? 0).toFixed(2)}`;
}

/** Bytes → binary size, 0–1 decimal ("51200"→"50 KB"). */
export function formatSize(bytes: number | undefined): string {
	const b = bytes ?? 0;
	if (b < 1024) return `${b} B`;
	const kb = b / 1024;
	if (kb < 1024) return `${kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb)} KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`;
	const gb = mb / 1024;
	return `${gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb)} GB`;
}

/** "zai/glm-5.3" → "glm-5.3" for compact rows; full id for peek headers. */
export function shortModel(model: string | undefined): string {
	if (!model) return "";
	const slash = model.lastIndexOf("/");
	return slash >= 0 ? model.slice(slash + 1) : model;
}

/**
 * State glyph + word (never color-alone, FIELDS §3.6). Returns the glyph and
 * the word separately so the caller colors them together.
 */
export function stateGlyph(state: string): { glyph: string; word: string; color: "success" | "warning" | "error" | "muted" } {
	switch (state) {
		case "created":
		case "starting":
			return { glyph: "◐", word: "starting", color: "muted" };
		case "running":
			return { glyph: "●", word: "running", color: "success" };
		case "succeeded":
			return { glyph: "✓", word: "done", color: "success" };
		case "cancelled":
			return { glyph: "⊘", word: "cancelled", color: "muted" };
		case "timed_out_idle":
			return { glyph: "⏱", word: "timeout · idle", color: "warning" };
		case "timed_out_hard":
			return { glyph: "⏱", word: "timeout · hard", color: "warning" };
		case "queued":
			return { glyph: "○", word: "queued", color: "muted" };
		default:
			return { glyph: "✗", word: state || "unknown", color: "error" };
	}
}

/** Progress bar: `filled(█) + empty(░)` + "NN%" text (never shape-alone). */
export function progressBar(frac: number, width: number): string {
	const f = Math.max(0, Math.min(1, frac));
	const w = Math.max(4, Math.floor(width));
	const filled = Math.round(f * w);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, w - filled))} ${Math.round(f * 100)}%`;
}
