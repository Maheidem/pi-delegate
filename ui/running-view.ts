/**
 * delegate — live child feed panel for command-driven foreground runs.
 *
 * A window into the running child: identity + budgets header, elapsed-vs-hard
 * progress, in-flight tools, and a bounded scrolling feed of the child's
 * activity (tool starts/ends, assistant lines, provider errors, handoff).
 *
 * RENDER CONTRACT (hard-won): this runs as an inline `ctx.ui.custom`
 * component, which REPLACES the composer region while a run is active. The
 * panel MUST render a FIXED number of rows every frame — a height that
 * changes between refreshes smears the previous frame over the input bar.
 * So: constant height, blank-padded, and color ONLY inner text (never the
 * border/padding structure, whose width Pi recomputes every frame).
 * Cancels via Escape twice (armed). Refresh cadence is owned by the host.
 */

import { truncateToWidth, visibleWidth, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager, ThemeColor } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokens, shortModel } from "./format.ts";

export interface RunningViewState {
	runId: string;
	role: string;
	/** Resolved child model ("provider/model"). */
	model?: string;
	phase: string;
	elapsedMs: number;
	/** Effective hard cap — drives the progress bar. */
	hardMs?: number;
	turns?: number;
	/** Tokens observed so far. */
	tokens?: { input?: number; output?: number };
	/** Tools currently in flight. */
	openTools?: string[];
	/** Pre-formatted feed lines (newest last); the panel slices/pads itself. */
	feedLines: string[];
}

export interface RunningViewHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	state(): RunningViewState;
	done(result: { cancelled?: boolean }): void;
}

/** Constant panel height (top + header + progress + in-flight + FEED + footer + bottom). */
const PANEL_ROWS = 9;
/** Feed rows inside the fixed frame; the rest are the fixed scaffold. */
const FEED_ROWS = PANEL_ROWS - 5;

export class RunningView implements Component {
	private readonly host: RunningViewHost;
	private cancelArmed = false;

	constructor(host: RunningViewHost) {
		this.host = host;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		const isCancelKey =
			(kb?.matches?.(data, "tui.select.cancel") ?? false) ||
			matchesKey(data, "escape") ||
			matchesKey(data, "q");
		if (isCancelKey) {
			// Cancel is destructive to the child — require a second press.
			if (this.cancelArmed) {
				this.host.done({ cancelled: true });
			} else {
				this.cancelArmed = true;
				this.invalidate();
			}
		}
	}

	invalidate(): void {
		// No internal cache: state() is cheap and host-driven refresh is 1 s.
	}

	render(width: number): string[] {
		const s = this.host.state();
		const theme = this.host.theme;
		const w = Math.max(1, Math.floor(width));
		const inner = Math.max(1, w - 4);

		// Borders stay UNSTYLED so Pi's per-frame width/clear math is exact;
		// color is applied to inner text only.
		const title = " Delegating ";
		const fill = Math.max(0, w - 2 - title.length - 2);
		const top = truncateToWidth(`╭─${title}${"─".repeat(fill + 1)}╮`, w);
		const bottom = truncateToWidth(`╰${"─".repeat(Math.max(0, w - 2))}╯`, w);
		const pad = (text: string, color?: ThemeColor) => {
			const body = color && theme?.fg ? theme.fg(color, truncateToWidth(text, inner)) : truncateToWidth(text, inner);
			return `│ ${body} │`;
		};
		const fg = (kind: ThemeColor, text: string) => (theme?.fg ? theme.fg(kind, text) : text);

		// Fixed scaffold rows — always exactly PANEL_ROWS - 2 inner rows.
		const head = [
			s.role,
			s.model ? shortModel(s.model) : undefined,
			formatDuration(s.elapsedMs),
			...(s.turns !== undefined ? [`turn ${s.turns}`] : []),
			...(s.tokens ? [`↑${formatTokens(s.tokens.input)} ↓${formatTokens(s.tokens.output)}`] : []),
		]
			.filter(Boolean)
			.join(" · ");

		let progress = "running…";
		if (s.hardMs && s.hardMs > 0) {
			const frac = Math.min(1, s.elapsedMs / s.hardMs);
			const barWidth = Math.max(4, Math.min(inner - 14, 24));
			const filled = Math.round(frac * barWidth);
			progress = `${"█".repeat(filled)}${"░".repeat(Math.max(0, barWidth - filled))} ${Math.round(frac * 100)}% of ${formatDuration(s.hardMs)} hard`;
		}

		const openTools = s.openTools ?? [];
		const inFlight = openTools.length > 0 ? `in flight: ${openTools.join(", ")}` : "";

		// Feed: newest last, right-aligned in a fixed block (blank-padded on top).
		const feed = s.feedLines.slice(-FEED_ROWS);
		const feedRows: string[] = [...Array<string>(Math.max(0, FEED_ROWS - feed.length)).fill(""), ...feed];

		const footer = this.cancelArmed ? fg("error", "ESC again: CONFIRM cancel") : "esc/q cancel (press twice)";

		// In-flight tools are the NORMAL state of a running child, not a
		// problem: amber ("warning") is read by humans as trouble, so this row
		// stays neutral/dim. Reserve "warning" for degraded and "error" for
		// failed (see skills/pi-extension-builder OPERATIONAL-EXTENSIONS.md).
		const inFlightColor: ThemeColor | undefined = openTools.length > 0 ? "dim" : undefined;

		// Assemble a fixed-height body: header, progress, in-flight, feed block, footer.
		const body: Array<[string, ThemeColor?]> = [
			[head],
			[progress, "accent"],
			[inFlight, inFlightColor],
			...feedRows.map((l): [string, ThemeColor?] => [l, l ? "text" : undefined]),
			[footer, this.cancelArmed ? "error" : "dim"],
		];

		const lines: string[] = [top, ...body.map(([t, c]) => pad(t, c)), bottom];

		// Belt-and-braces: hard-clip to the exact height and width.
		const clipped = lines.slice(0, PANEL_ROWS);
		while (clipped.length < PANEL_ROWS) clipped.splice(clipped.length - 1, 0, pad(""));
		return clipped.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
	}
}
