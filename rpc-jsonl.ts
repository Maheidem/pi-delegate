/**
 * delegate — strict LF-delimited JSONL parser for child RPC stdout
 * (NFR-003: NEVER Node's `readline`).
 *
 * Rules (§9.7):
 *  - split only on LF (\n);
 *  - strip ONE trailing CR per record (CRLF children tolerated);
 *  - U+2028/U+2029 inside JSON strings stay data (no line-based splitting);
 *  - incomplete final buffer retained until the next chunk or close();
 *  - maximum individual record size (default 8 MiB) → oversize diagnostic;
 *  - malformed records are classified diagnostics, never silently dropped;
 *  - bounded malformed threshold → protocol failure.
 */

export interface RpcRecord {
	/** Exact record bytes before the delimiter (CR already stripped). */
	raw: Buffer;
	/** Parsed JSON value, or null when the record is malformed. */
	parsed: unknown;
	malformed: boolean;
}

export type RpcRecordClassification =
	| { kind: "prompt_response"; ok: boolean; id: string }
	| { kind: "message_end"; stopReason?: string }
	| { kind: "tool_event"; phase: "start" | "update" | "end"; id?: string; toolName?: string; args?: Record<string, unknown>; result?: { details?: unknown; isError?: boolean; textHead?: string } }
	| { kind: "agent_settled" }
	| { kind: "agent_end" }
	| { kind: "extension_ui_request"; id: string }
	| { kind: "extension_error" }
	| { kind: "unknown"; type?: string }
	| { kind: "malformed" };

export interface RpcParserOptions {
	maxRecordBytes?: number;
	malformedThreshold?: number;
	onOversized?: (size: number) => void;
	onMalformed?: (raw: Buffer, index: number) => void;
}

export const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024; // 8 MiB

function isArgsObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
export const DEFAULT_MALFORMED_THRESHOLD = 10;

export class RpcJsonlParser {
	private buffer: Buffer = Buffer.alloc(0);
	private malformedCount = 0;
	private readonly maxRecordBytes: number;
	private readonly malformedThreshold: number;
	private readonly onOversized?: (size: number) => void;
	private readonly onMalformed?: (raw: Buffer, index: number) => void;
	private recordIndex = 0;
	/** True once an oversized record was observed (fatal by contract). */
	oversized = false;

	constructor(options: RpcParserOptions = {}) {
		this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
		this.malformedThreshold = options.malformedThreshold ?? DEFAULT_MALFORMED_THRESHOLD;
		this.onOversized = options.onOversized;
		this.onMalformed = options.onMalformed;
	}

	get malformedRecords(): number {
		return this.malformedCount;
	}

	get exceededMalformedThreshold(): boolean {
		return this.malformedCount > this.malformedThreshold;
	}

	/** Feed a stdout chunk; returns zero or more complete records. */
	feed(chunk: Buffer | string): RpcRecord[] {
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
		this.buffer = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
		const out: RpcRecord[] = [];

		for (;;) {
			const lf = this.buffer.indexOf(0x0a); // LF only
			if (lf === -1) break;
			let recordBytes = this.buffer.subarray(0, lf);
			// Strip ONE trailing CR (CRLF tolerance). U+2028/2029 are 0xE2
			// 0x80 0xA8/0xA9 in UTF-8 and are never 0x0d — safe.
			if (recordBytes.length > 0 && recordBytes[recordBytes.length - 1] === 0x0d) {
				recordBytes = recordBytes.subarray(0, recordBytes.length - 1);
			}
			this.buffer = this.buffer.subarray(lf + 1);
			out.push(this.acceptRecord(recordBytes));
		}
		return out;
	}

	/** Flush any incomplete final record (captured on process close). */
	close(): RpcRecord[] {
		if (this.buffer.length === 0) return [];
		const recordBytes = this.buffer;
		this.buffer = Buffer.alloc(0);
		return [this.acceptRecord(recordBytes)];
	}

	private acceptRecord(raw: Buffer): RpcRecord {
		const size = raw.length;
		if (size > this.maxRecordBytes) {
			this.oversized = true;
			this.onOversized?.(size);
			return { raw, parsed: null, malformed: true };
		}
		const index = this.recordIndex++;
		let parsed: unknown;
		let malformed = false;
		try {
			parsed = JSON.parse(raw.toString("utf8"));
		} catch {
			parsed = null;
			malformed = true;
			this.malformedCount += 1;
			this.onMalformed?.(raw, index);
		}
		return { raw, parsed, malformed };
	}
}

/**
 * Classify one parsed RPC record into a semantic action for the runner.
 * Unknown-but-valid events return kind "unknown" and MUST still be
 * persisted; they are ignored semantically only.
 */
export function classifyRpcRecord(record: RpcRecord): RpcRecordClassification {
	if (record.malformed || !record.parsed || typeof record.parsed !== "object") {
		return { kind: "malformed" };
	}
	const obj = record.parsed as Record<string, unknown>;
	switch (obj.type) {
		case "response": {
			const ok = obj.error === undefined && obj.success !== false;
			return { kind: "prompt_response", ok, id: typeof obj.id === "string" ? obj.id : "" };
		}
		case "message_end": {
			const message = (obj.message ?? {}) as Record<string, unknown>;
			return {
				kind: "message_end",
				stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
			};
		}
		case "tool_execution_start":
			return {
				kind: "tool_event",
				phase: "start",
				id: typeof obj.toolCallId === "string" ? obj.toolCallId : undefined,
				toolName: typeof obj.toolName === "string" ? obj.toolName : undefined,
				args: isArgsObject(obj.args) ? (obj.args as Record<string, unknown>) : undefined,
			};
		case "tool_execution_update":
			return {
				kind: "tool_event",
				phase: "update",
				id: typeof obj.toolCallId === "string" ? obj.toolCallId : undefined,
				toolName: typeof obj.toolName === "string" ? obj.toolName : undefined,
			};
		case "tool_execution_end": {
			const result = (obj.result ?? {}) as Record<string, unknown>;
			const content = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
			let textHead = "";
			for (const b of content) {
				if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
					textHead = b.text.trim().slice(0, 240);
					break;
				}
			}
			return {
				kind: "tool_event",
				phase: "end",
				id: typeof obj.toolCallId === "string" ? obj.toolCallId : undefined,
				toolName: typeof obj.toolName === "string" ? obj.toolName : undefined,
				...(result && typeof result === "object"
					? {
							result: {
								details: result.details,
								// Authoritative flags only. Pi emits `isError` at the TOP level of
								// the event (verified against captured transcripts); `result.isError`
								// is unset there. Reading only `result.isError` silently marked every
								// genuine tool failure as success. Content is NEVER a failure signal.
								isError:
									obj.isError === true ||
									obj.is_error === true ||
									result.isError === true ||
									result.is_error === true,
								...(textHead ? { textHead } : {}),
							},
						}
					: {}),
			};
		}
		case "agent_settled":
			return { kind: "agent_settled" };
		case "agent_end":
			return { kind: "agent_end" };
		case "extension_ui_request":
			return { kind: "extension_ui_request", id: typeof obj.id === "string" ? obj.id : "" };
		case "extension_error":
			return { kind: "extension_error" };
		default:
			return { kind: "unknown", type: typeof obj.type === "string" ? obj.type : undefined };
	}
}
