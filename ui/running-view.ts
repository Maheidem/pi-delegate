/**
 * delegate — live child feed panel for command-driven foreground runs.
 *
 * A window into the running child: identity + budgets header, elapsed-vs-hard
 * progress, in-flight tools, and a bounded scrolling feed of the child's
 * activity (tool starts/ends, assistant lines, provider errors, handoff).
 * Cancels via Escape twice (armed). Refresh cadence is owned by the host
 * (1 s); feed lines arrive pre-formatted from the adapter's event ring.
 */

import { truncateToWidth, visibleWidth, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager, ThemeColor } from "@earendil-works/pi-coding-agent";

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
	/** Pre-formatted feed lines (newest last), already clipped. */
	feedLines: string[];
}

export interface RunningViewHost {
	theme: Theme;
	keybindings: KeybindingsManager;
	state(): RunningViewState;
	done(result: { cancelled?: boolean }): void;
}

function fmtDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fmtTokens(n?: number): string {
	if (!n) return "0";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
	return `${Math.round(n / 100_000) / 10}M`;
}

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
		const title = " Delegating ";
		const border = "─".repeat(Math.max(0, w - title.length - 2));
		const top = `╭─${title}${border.slice(0, Math.max(0, border.length))}─╮`.slice(0, w);
		const bottom = `╰${"─".repeat(Math.max(0, w - 2))}╯`.slice(0, w);
		const inner = Math.max(1, w - 4);
		const pad = (text: string, color?: ThemeColor) => {
			const line = `│ ${truncateToWidth(text, inner)} │`;
			return color && theme?.fg ? theme.fg(color, line) : line;
		};

		const fg = (kind: ThemeColor, text: string) => (theme?.fg ? theme.fg(kind, text) : text);
		const lines: string[] = [top];

		// Header: identity + elapsed + turns + tokens.
		const head = [
			s.role,
			s.model,
			fg("accent", fmtDuration(s.elapsedMs)),
			...(s.turns !== undefined ? [`turn ${s.turns}`] : []),
			...(s.tokens ? [`↑${fmtTokens(s.tokens.input)} ↓${fmtTokens(s.tokens.output)}`] : []),
		]
			.filter(Boolean)
			.join(" · ");
		lines.push(pad(head));

		// Progress: elapsed vs hard cap (never color-only — text carries %).
		if (s.hardMs && s.hardMs > 0) {
			const frac = Math.min(1, s.elapsedMs / s.hardMs);
			const barWidth = Math.max(4, Math.min(inner - 14, 24));
			const filled = Math.round(frac * barWidth);
			const bar = `${"█".repeat(filled)}${"░".repeat(Math.max(0, barWidth - filled))}`;
			lines.push(pad(`${bar} ${Math.round(frac * 100)}% of ${fmtDuration(s.hardMs)} hard`));
		}

		// In-flight tools.
		if (s.openTools && s.openTools.length > 0) {
			lines.push(pad(fg("warning", `in flight: ${s.openTools.join(", ")}`)));
		}

		// Feed: newest last; take as many as fit the budget.
		const feedBudget = Math.max(0, 16 - lines.length - 2);
		const feed = s.feedLines.slice(-feedBudget);
		if (feed.length > 0) {
			for (const line of feed) lines.push(pad(line, "text"));
		} else {
			lines.push(pad("starting — waiting for the child's first events…", "muted"));
		}

		// Footer.
		lines.push(
			pad(
				this.cancelArmed
					? fg("error", "ESC again: CONFIRM cancel")
					: "esc/q cancel (press twice)",
				this.cancelArmed ? "error" : "dim",
			),
		);
		lines.push(bottom);

		// Width safety: hard-clip rather than corrupt layout.
		return lines.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
	}
}
