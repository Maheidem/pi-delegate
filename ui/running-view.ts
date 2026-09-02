/**
 * delegate — compact live running view for command-driven foreground runs.
 *
 * Renders ≤ ~4 bounded lines (status, elapsed, last actions) inside a
 * width-safe bordered box and cancels via Escape (done({ cancel: true })).
 * Keyboard uses the injected KeybindingsManager where available; Escape is
 * the canonical cancel. Refresh cadence is owned by the host (1 s).
 */

import { truncateToWidth, visibleWidth, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";

export interface RunningViewState {
	runId: string;
	role: string;
	phase: string;
	elapsedMs: number;
	lastActions: string[];
}

export interface RunningViewHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	state(): RunningViewState;
	done(result: { cancelled?: boolean }): void;
}

export class RunningView implements Component {
	private readonly host: RunningViewHost;
	private cachedLines: string[] | undefined;
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
			// §12 — confirm cancellation of a running child before signalling.
			if (this.cancelArmed) {
				this.host.done({ cancelled: true });
			} else {
				this.cancelArmed = true;
				this.invalidate();
			}
		}
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const s = this.host.state();
		const theme = this.host.theme;
		const w = Math.max(1, Math.floor(width));
		const secs = Math.round(s.elapsedMs / 1000);
		const title = truncateToWidth(" Delegating ", Math.max(4, w - 4));
		const border = "─".repeat(Math.max(0, w - title.length - 2));
		const top = `╭─${title}${border}─╮`;
		const bottom = `╰${"─".repeat(Math.max(0, w - 2))}╯`;
		const inner = Math.max(1, w - 4);
		const pad = (text: string) => `│ ${truncateToWidth(text, inner)} │`;
		const lines: string[] = [top, pad(`${s.role} · ${s.phase} · ${secs}s`), pad(s.runId)];
		for (const action of s.lastActions.slice(-2)) {
			lines.push(pad(`· ${action}`));
		}
		lines.push(pad(this.cancelArmed ? "ESC again: CONFIRM cancel" : "esc cancel"));
		lines.push(bottom);
		// Width safety: every rendered line must fit the available width.
		for (const line of lines) {
			if (visibleWidth(line) > w) {
				// Fallback: clip hard rather than corrupt layout.
				return [truncateToWidth(top, w), ...lines.map((l) => truncateToWidth(l, w))].slice(0, Math.max(1, Math.min(lines.length, 20)));
			}
		}
		this.cachedLines = lines;
		return lines;
	}
}
