/**
 * delegate — child-activity feed formatting (Pi-free).
 *
 * One formatter, two consumers: the live running panel (in-memory events
 * pushed by the runner) and `/delegate peek` (events decoded from the
 * captured RPC transcript on disk). Everything bounded and width-safe by
 * character count; components truncate to terminal width themselves.
 */

import * as fs from "node:fs";
import { decodeTranscriptRecord, type TranscriptRecordV1 } from "./types.ts";

/** One feed event, whether captured live or decoded from a transcript. */
export interface FeedEvent {
	/** Epoch ms (live) or ISO string (transcript) — normalized to ms. */
	atMs: number;
	kind: "tool_start" | "tool_end" | "assistant" | "provider_error" | "handoff" | "settled" | "info";
	tool?: string;
	detail: string;
	/** tool_end: failure marker. */
	isError?: boolean;
	/** tool_end: duration ms when known. */
	durationMs?: number;
}

export interface FeedRenderOptions {
	/** Feed window start (epoch ms) — events are stamped +Ns relative to it. */
	startMs: number;
	/** Maximum events kept/rendered. */
	maxEvents?: number;
	/** Maximum characters per line. */
	maxChars?: number;
}

const DEFAULT_MAX_EVENTS = 200;
const DEFAULT_MAX_CHARS = 160;

function clip(text: string, max: number): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Render feed events as bounded one-liners: `+42s ▶ bash npm test`. */
export function renderFeedEvents(events: FeedEvent[], opts: FeedRenderOptions): string[] {
	const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
	const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
	const lines: string[] = [];
	for (const e of events.slice(-maxEvents)) {
		const rel = Math.max(0, Math.round((e.atMs - opts.startMs) / 1000));
		const ts = rel >= 60 ? `${Math.floor(rel / 60)}m${String(rel % 60).padStart(2, "0")}s` : `${rel}s`;
		let mark = "·";
		let text = e.detail;
		switch (e.kind) {
			case "tool_start":
				mark = "▶";
				text = e.tool ? `${e.tool} ${e.detail}` : e.detail;
				break;
			case "tool_end":
				mark = e.isError ? "✗" : "✓";
				text = e.tool ? `${e.tool} ${e.detail}` : e.detail;
				if (e.durationMs !== undefined) text += ` (${Math.round(e.durationMs / 1000)}s)`;
				break;
			case "assistant":
				mark = "✎";
				break;
			case "provider_error":
				mark = "⚠";
				break;
			case "handoff":
				mark = "▣";
				break;
			case "settled":
				mark = "◉";
				break;
		}
		lines.push(clip(`+${ts} ${mark} ${text}`, maxChars));
	}
	return lines;
}

/** Live feed ring: bounded append with drop-oldest. */
export class FeedRing {
	private readonly events: FeedEvent[] = [];
	private readonly capacity: number;
	constructor(capacity = 120) {
		this.capacity = capacity;
	}
	push(event: FeedEvent): void {
		this.events.push(event);
		if (this.events.length > this.capacity) this.events.shift();
	}
	all(): readonly FeedEvent[] {
		return this.events;
	}
}

interface ParsedRecord {
	receivedAtMs: number;
	type?: string;
	toolCallId?: string;
	toolName?: string;
	args?: unknown;
	/** Authoritative failure flag — Pi carries it at the TOP level. */
	isError?: boolean;
	is_error?: boolean;
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
		is_error?: boolean;
		details?: { delegateHandoff?: { outcome?: string } };
	};
	message?: {
		role?: string;
		stopReason?: string;
		errorMessage?: string;
		content?: Array<{ type?: string; text?: string; thinking?: string }>;
	};
}

function parseEnvelope(line: string): { atMs: number; rec: ParsedRecord | null } {
	try {
		const env = JSON.parse(line) as TranscriptRecordV1;
		const atMs = Date.parse(env.receivedAt);
		let rec: ParsedRecord | null = null;
		try {
			rec = JSON.parse(decodeTranscriptRecord(env)) as ParsedRecord;
		} catch {
			rec = null;
		}
		return { atMs: Number.isFinite(atMs) ? atMs : 0, rec };
	} catch {
		return { atMs: 0, rec: null };
	}
}

/**
 * Authoritative failure flags ONLY. Pi's `tool_execution_end` records carry
 * `isError` at the TOP level of the record (`result.isError` is unset in
 * captured transcripts), so both positions are read; snake_case `is_error` is
 * tolerated for other RPC producers.
 *
 * NEVER infer failure from result *content*: a successful `read` of a source
 * file whose text contains `throw new Error("…")` is a SUCCESS, and a red
 * `✗ read …` in the live feed is indistinguishable from a real failure to
 * the user (cautionary instance: run del_20260908T113930Z_72cc3f31).
 */
function toolFailed(rec: ParsedRecord): boolean {
	return (
		rec.isError === true ||
		rec.is_error === true ||
		rec.result?.isError === true ||
		rec.result?.is_error === true
	);
}

function resultTextHead(result: ParsedRecord["result"]): string {
	const blocks = result?.content ?? [];
	for (const b of blocks) {
		if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) return b.text;
	}
	return "";
}

/**
 * Decode the tail of a captured child transcript into feed events — the
 * backing store for `/delegate peek` (live runs grow the file in real time).
 */
export function feedEventsFromTranscript(
	transcriptPath: string,
	opts?: { maxEvents?: number; maxBytes?: number },
): { startMs: number; events: FeedEvent[] } {
	const maxEvents = opts?.maxEvents ?? 120;
	const maxBytes = opts?.maxBytes ?? 1_500_000;
	const events: FeedEvent[] = [];
	let startMs = 0;
	try {
		const stat = fs.statSync(transcriptPath);
		const fd = fs.openSync(transcriptPath, "r");
		try {
			const readFrom = Math.max(0, stat.size - maxBytes);
			const buf = Buffer.alloc(stat.size - readFrom);
			fs.readSync(fd, buf, 0, buf.length, readFrom);
			const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
			// A tail cut can start mid-line; drop a partial first line.
			if (readFrom > 0 && lines.length > 0) lines.shift();
			const openTools = new Map<string, { name?: string; atMs: number; detail?: string }>();
			for (const line of lines) {
				const { atMs, rec } = parseEnvelope(line);
				if (!rec || !atMs) continue;
				if (startMs === 0) startMs = atMs;
				switch (rec.type) {
					case "tool_execution_start": {
						const name = rec.toolName ?? "tool";
						const detail = describeArgs(name, rec.args);
						openTools.set(rec.toolCallId ?? String(events.length), { name, atMs, detail });
						events.push({ atMs, kind: "tool_start", tool: name, detail });
						break;
					}
					case "tool_execution_end": {
						const name = rec.toolName ?? "tool";
						const open = openTools.get(rec.toolCallId ?? "");
						openTools.delete(rec.toolCallId ?? "");
						// End lines echo the start's arg detail (path/command) —
						// file-content heads are noise; bash keeps its output head.
						const head = resultTextHead(rec.result);
						const detail =
							name === "bash" && head
								? clip(head, 70)
								: (open?.detail || (head ? clip(head, 70) : "done"));
						events.push({
							atMs,
							kind: "tool_end",
							tool: name,
							detail,
							// Status flags only — `head` is untrusted content (see toolFailed).
							isError: toolFailed(rec),
							...(open ? { durationMs: atMs - open.atMs } : {}),
						});
						break;
					}
					case "message_end": {
						const m = rec.message ?? {};
						if (m.role !== "assistant") break;
						if (m.stopReason === "error") {
							events.push({
								atMs,
								kind: "provider_error",
								detail: m.errorMessage?.trim() || "provider error (no message)",
							});
							break;
						}
						const blocks = m.content ?? [];
						const handoff = rec as unknown as { toolName?: string };
						void handoff;
						let text = "";
						for (const b of blocks) if (b?.type === "text" && b.text?.trim()) text = b.text;
						if (text.trim()) events.push({ atMs, kind: "assistant", detail: text.split("\n").filter(Boolean)[0] ?? text });
						break;
					}
					case "agent_settled":
						events.push({ atMs, kind: "settled", detail: "agent settled" });
						break;
					default:
						break;
				}
			}
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// unreadable/missing transcript → empty feed
	}
	return { startMs, events: events.slice(-maxEvents) };
}

function describeArgs(tool: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const v = a.command ?? a.path ?? a.pattern ?? a.query;
	if (typeof v === "string") return clip(v, 90);
	if (tool === "handoff") return "structured submission";
	return "";
}
