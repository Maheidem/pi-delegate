/**
 * delegate — `/delegate peek` overlay: a scrollable, live-following view of
 * a child's activity, decoded from its captured RPC transcript (works for
 * the active run AND post-mortem). The host owns the refresh timer (1 s
 * while following) and must clear it when the overlay closes.
 */

import { truncateToWidth, visibleWidth, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager, ThemeColor } from "@earendil-works/pi-coding-agent";
import { frameHeight, padToFrame } from "./panel-frame.ts";
import type { PanelSnapshot } from "./settings-panel.ts";

export interface PeekViewState {
	/** Header: run id + state/model. */
	title: string;
	/** One muted summary line (path, size, role, finished state…). */
	summary: string;
	/** Formatted feed lines, oldest first (newest at the bottom). */
	lines: string[];
	/** True while the run is still active (enables follow). */
	live: boolean;
}

export interface PeekViewHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	state(): PeekViewState;
	done(result: { closed?: boolean }): void;
}

/**
 * Content rows inside the fixed frame — the canonical frame's detail
 * window. Builder-side: newest at the bottom, blank-padded on top, ALWAYS
 * exactly CONTENT_ROWS tall (panel-frame rule: the frame never grows).
 */
const CONTENT_ROWS = 16;

/**
 * Fixed overlay height, DERIVED from the canonical panel-frame grammar:
 * top + content window + message (summary row) + navigation (status row) +
 * bottom. Rows never change between frames (smear guard).
 */
const PEEK_ROWS = frameHeight({
	title: "",
	sections: [],
	detailLines: Array.from({ length: CONTENT_ROWS }, () => ""),
});

export class PeekView implements Component {
	private readonly host: PeekViewHost;
	private offsetFromEnd = 0;
	private following = true;
	private lastLineCount = 0;

	constructor(host: PeekViewHost) {
		this.host = host;
	}

	handleInput(data: string): void {
		const kb = this.host.keybindings;
		const up = (kb?.matches?.(data, "tui.select.up") ?? false) || matchesKey(data, "j");
		const down = (kb?.matches?.(data, "tui.select.down") ?? false) || matchesKey(data, "k");
		const cancel =
			(kb?.matches?.(data, "tui.select.cancel") ?? false) ||
			matchesKey(data, "escape") ||
			matchesKey(data, "q");
		const maxOffset = Math.max(0, this.host.state().lines.length - CONTENT_ROWS);
		if (cancel) {
			this.host.done({ closed: true });
		} else if (up) {
			this.following = false;
			this.offsetFromEnd = Math.min(maxOffset, this.offsetFromEnd + 1);
		} else if (down) {
			this.offsetFromEnd = Math.max(0, this.offsetFromEnd - 1);
			if (this.offsetFromEnd === 0) this.following = true;
		} else if (matchesKey(data, "f")) {
			this.following = true;
			this.offsetFromEnd = 0;
		}
	}

	invalidate(): void {
		// Rendered from host state each frame; no cache to clear.
	}

	render(width: number): string[] {
		const s = this.host.state();
		const theme = this.host.theme;
		const w = Math.max(1, Math.floor(width));
		const inner = Math.max(1, w - 4);

		// Borders stay UNSTYLED so Pi's per-frame width/clear math is exact;
		// color is applied to inner text only.
		const title = truncateToWidth(` Peek · ${s.title} `, Math.max(4, w - 4));
		const top = truncateToWidth(`╭─${title}${"─".repeat(Math.max(0, w - 2 - title.length - 1))}╮`, w);
		const bottom = truncateToWidth(`╰${"─".repeat(Math.max(0, w - 2))}╯`, w);
		const pad = (text: string, color?: ThemeColor) => {
			const body = color && theme?.fg ? theme.fg(color, truncateToWidth(text, inner)) : truncateToWidth(text, inner);
			return `│ ${body} │`;
		};

		// Fixed-height viewport: exactly CONTENT_ROWS, newest at the bottom
		// (blank-padded at the top) so the frame height never changes.
		const total = s.lines.length;
		if (total !== this.lastLineCount && this.following) this.offsetFromEnd = 0;
		this.lastLineCount = total;
		const maxOffset = Math.max(0, total - CONTENT_ROWS);
		if (this.offsetFromEnd > maxOffset) this.offsetFromEnd = maxOffset;
		const end = total - this.offsetFromEnd;
		const start = Math.max(0, end - CONTENT_ROWS);
		const window = s.lines.slice(start, end);
		const content = [...Array<string>(Math.max(0, CONTENT_ROWS - window.length)).fill(""), ...window];

		const counts = [start > 0 ? `↑${start}` : "", end < total ? `↓${total - end}` : ""].filter(Boolean).join(" ");
		const status = s.live
			? `● live — following · j/k scroll · f re-follow · q close${counts ? ` · ${counts}` : ""}`
			: `final — ${total} event(s) · j/k scroll · q close${counts ? ` · ${counts}` : ""}`;

		// Frame arithmetic through the canonical helper: the window is the
		// grammar's detail block; the summary row occupies the grammar's
		// message slot and the status row its navigation slot (both rendered
		// locally with the colours this overlay needs — the grammar counts them
		// unconditionally, so they never appear in the snapshot). padToFrame is
		// a no-op while the builder invariant holds (window exactly
		// CONTENT_ROWS) and is the tripwire the moment any slot count drifts.
		const snapshot: PanelSnapshot = {
			title,
			sections: [],
			detailLines: content,
		};
		const windowRows = padToFrame(snapshot, PEEK_ROWS).detailLines ?? [];

		const lines: string[] = [
			top,
			pad(truncateToWidth(s.summary, inner), "muted"),
			pad(status, s.live ? "success" : "dim"),
			...windowRows.map((l) => pad(l, l ? "text" : undefined)),
			bottom,
		];

		// Belt-and-braces: exact height, exact width.
		const clipped = lines.slice(0, PEEK_ROWS);
		while (clipped.length < PEEK_ROWS) clipped.splice(clipped.length - 1, 0, pad(""));
		return clipped.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
	}
}
