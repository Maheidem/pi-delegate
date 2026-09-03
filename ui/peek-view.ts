/**
 * delegate — `/delegate peek` overlay: a scrollable, live-following view of
 * a child's activity, decoded from its captured RPC transcript (works for
 * the active run AND post-mortem). The host owns the refresh timer (1 s
 * while following) and must clear it when the overlay closes.
 */

import { truncateToWidth, visibleWidth, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager, ThemeColor } from "@earendil-works/pi-coding-agent";

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
		if (cancel) {
			this.host.done({ closed: true });
		} else if (up) {
			this.following = false;
			this.offsetFromEnd += 1;
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
		const fg = (kind: ThemeColor, text: string) => (theme?.fg ? theme.fg(kind, text) : text);
		const title = ` Peek · ${s.title} `;
		const top = `╭─${truncateToWidth(title, Math.max(4, w - 4))}${"─".repeat(Math.max(0, w - 3 - Math.min(title.length, Math.max(4, w - 4))))}─╮`;
		const bottom = `╰${"─".repeat(Math.max(0, w - 2))}╯`;
		const inner = Math.max(1, w - 4);
		const pad = (text: string, color?: ThemeColor) => {
			const line = `│ ${truncateToWidth(text, inner)} │`;
			return color && theme?.fg ? theme.fg(color, line) : line;
		};

		// Viewport: keep the overlay in the 20–24 line budget.
		const maxFeed = Math.max(1, 20 - 4);
		const total = s.lines.length;
		if (total !== this.lastLineCount && this.following) this.offsetFromEnd = 0;
		this.lastLineCount = total;
		const end = Math.max(0, total - this.offsetFromEnd);
		const start = Math.max(0, end - maxFeed);
		const window = s.lines.slice(start, end);

		const lines: string[] = [
			truncateToWidth(top, w),
			pad(s.summary, "muted"),
			pad(
				s.live
					? fg("success", `● live — following (j/k scroll, f re-follow, q close)`)
					: `final — ${total} events (j/k scroll, q close)`,
				s.live ? "success" : "dim",
			),
		];
		if (total === 0) {
			lines.push(pad("no activity captured", "muted"));
		} else {
			for (const line of window) lines.push(pad(line));
			if (start > 0) lines.push(pad(`… ${start} earlier event(s) — j to scroll up`, "dim"));
			if (end < total) lines.push(pad(`… ${total - end} newer event(s) — k to scroll down`, "dim"));
		}
		lines.push(truncateToWidth(bottom, w));
		return lines.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
	}
}
