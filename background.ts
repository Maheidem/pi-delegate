/**
 * delegate — background run manager (R8–R13).
 *
 * Pi-free: delivery and ledger writes are injected ports (wired in
 * index.ts), so every behavior here is unit-testable with fakes. The
 * session JSONL is the source of truth for background-run ownership
 * (`delegate.background` custom entries, schema v1); receipts remain the
 * detailed durable record. Semantics ported from pi-async-fork
 * (SPEC §1): serialized at-least-once delivery with branch-scan dedup,
 * generation guard across session replacement, delivery pause across
 * tree switches, and reconcile-on-activation for runs that finished
 * while their owning branch was inactive.
 */

import type {
	BackgroundCreatedEntry,
	BackgroundFinishedEntry,
	BackgroundRunHandle,
	BackgroundRunRecord,
	DelegateError,
	DelegateRunResult,
	RoleName,
	RunMetadataV1,
	RunState,
	RunTerminalState,
	SessionEntryLike,
} from "./types.ts";
import { isTerminalRunState } from "./types.ts";
import { isPidAlive, readRunMetadata } from "./run-store.ts";

/** R11: ledger custom-entry type (session JSONL). */
export const BACKGROUND_LEDGER_TYPE = "delegate.background";
/** R10: terminal-result custom-message type. */
export const BACKGROUND_RESULT_TYPE = "delegate-background-result";

/** R12: was a terminal result for this run already delivered on the branch? */
export function wasResultDelivered(branch: readonly SessionEntryLike[], runId: string): boolean {
	return branch.some((entry) => {
		if (entry?.type !== "custom_message") return false;
		if (entry.customType !== BACKGROUND_RESULT_TYPE) return false;
		const details = (entry as { details?: unknown }).details;
		return Boolean(details && typeof details === "object" &&
			(details as { runId?: unknown }).runId === runId);
	});
}

function isBackgroundLedgerEntry(data: unknown): data is BackgroundCreatedEntry | BackgroundFinishedEntry {
	if (!data || typeof data !== "object") return false;
	const raw = data as Record<string, unknown>;
	if (raw.v !== 1) return false;
	if (raw.type === "created") {
		return typeof raw.runId === "string"
			&& (raw.role === "general" || raw.role === "research")
			&& typeof raw.description === "string"
			&& typeof raw.createdAt === "string";
	}
	if (raw.type === "finished") {
		return typeof raw.runId === "string" && typeof raw.finishedAt === "string"
			&& typeof raw.state === "string" && isTerminalRunState(raw.state as RunTerminalState);
	}
	return false;
}

/** R11: project the branch root-to-tip into background-run records.
 * Malformed entries are skipped and counted — never fatal. */
export function projectBackgroundRuns(branch: readonly SessionEntryLike[]): {
	records: Map<string, BackgroundRunRecord>;
	skipped: number;
} {
	const records = new Map<string, BackgroundRunRecord>();
	let skipped = 0;
	for (const entry of branch) {
		if (entry?.type !== "custom" || entry.customType !== BACKGROUND_LEDGER_TYPE) continue;
		if (!isBackgroundLedgerEntry(entry.data)) {
			skipped += 1;
			continue;
		}
		const data = entry.data;
		if (data.type === "created") {
			records.set(data.runId, { created: data });
		} else {
			const existing = records.get(data.runId);
			if (existing && !existing.finished) {
				records.set(data.runId, { ...existing, finished: data });
			} else if (!existing) {
				// finished without created on this branch: unowned, skip
				skipped += 1;
			}
		}
	}
	return { records, skipped };
}

/**
 * R8: background `description` validation (pi-async-fork rule, SPEC §1):
 * trimmed outer whitespace, 3–6 whitespace-separated words, single line —
 * C0/C1 controls and U+2028/U+2029 rejected. Returns the normalized value
 * or an error message.
 */
export function validateBackgroundDescription(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
	if (typeof raw !== "string") return { ok: false, error: "description must be a string." };
	const value = raw.trim();
	if (!value) return { ok: false, error: "description is required for background runs." };
	if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
		return { ok: false, error: "description must be a single line (control characters rejected)." };
	}
	const words = value.split(/\s+/).filter(Boolean);
	if (words.length < 3 || words.length > 6) {
		return { ok: false, error: `description must be 3 to 6 words (got ${words.length}).` };
	}
	return { ok: true, value };
}

/** State word for headers (same mapping as the foreground result header). */
export function backgroundStateWord(state: RunTerminalState): string {
	if (state === "succeeded") return "completed";
	if (state === "cancelled") return "cancelled";
	if (state.startsWith("timed_out")) return state.replace("_", " ");
	return state;
}

/**
 * R10: the model-visible terminal envelope (SPEC §5, byte-exact).
 * `runText` is the deterministic foreground-style result rendering
 * (formatRunText) reused verbatim.
 */
export function formatBackgroundResultEnvelope(
	runId: string,
	role: RoleName,
	description: string,
	state: RunTerminalState,
	runText: string,
): string {
	return (
		`[delegate background ${runId} · ${role} · ${description}: ${backgroundStateWord(state)}]\n` +
		"\n" +
		"This is the terminal report of a background delegation. The run has finished and\n" +
		"cannot receive steering. Treat it as an internal work event: write user-visible\n" +
		"text only if material, and do not re-narrate the handoff.\n" +
		"\n" +
		runText
	);
}

/** R8: the immediate tool-result content for a background spawn. */
export function formatBackgroundStartedText(runId: string, role: RoleName, description: string): string {
	return (
		`[delegate background started · ${runId} · ${role} · ${description}]\n` +
		"The run executes outside this turn. Poll it with the delegate_status tool\n" +
		"(delegate_status({ runId: \"" + runId + "\" })). The terminal report arrives as a\n" +
		"message when the run finishes — do not wait inline for it."
	);
}

/** R12: rebuild a DelegateRunResult from a receipt (replay/reconcile path). */
export function receiptToRunResult(metadata: RunMetadataV1): DelegateRunResult {
	const ok = metadata.state === "succeeded";
	const durationMs = metadata.startedAt && metadata.finishedAt
		? Math.max(0, Date.parse(metadata.finishedAt) - Date.parse(metadata.startedAt))
		: 0;
	return {
		ok,
		handoff: metadata.finalHandoff ?? "",
		details: {
			schemaVersion: 1,
			runId: metadata.runId,
			role: metadata.role,
			state: metadata.state as RunTerminalState,
			startedAt: metadata.startedAt ?? metadata.createdAt,
			finishedAt: metadata.finishedAt ?? metadata.createdAt,
			durationMs,
			model: metadata.model,
			...(metadata.thinkingLevel ? { thinkingLevel: metadata.thinkingLevel } : {}),
			exitCode: metadata.exitCode,
			stopReason: metadata.stopReason,
			usage: metadata.usage,
			outputBytes: metadata.outputBytes ?? 0,
			outputTruncated: metadata.outputTruncated ?? false,
			...(metadata.partialHandoff ? { partialHandoff: metadata.partialHandoff } : {}),
			...(metadata.sessionPath ? { sessionPath: metadata.sessionPath } : {}),
			transcriptPath: metadata.transcriptPath,
			stderrPath: metadata.stderrPath,
			displayItems: [],
		},
		...(metadata.errorCode
			? { error: { code: metadata.errorCode, message: metadata.errorMessage ?? "" } }
			: {}),
	};
}

export interface BackgroundManagerPorts {
	/** pi.sendMessage(message, options) — wired by the adapter. */
	sendMessage(message: {
		customType: string;
		content: string;
		display: true;
		details: Record<string, unknown>;
	}, options: { deliverAs: "steer"; triggerTurn: boolean }): unknown;
	/** pi.appendEntry(customType, data) — wired by the adapter. */
	appendEntry(customType: string, data: unknown): unknown;
	/** Live config accessor (slot limit). */
	maxBackgroundRuns(): number;
	/** Renders a terminal DelegateRunResult to text (formatRunText). */
	formatRun: (res: DelegateRunResult) => string;
	/** Receipt lookup for reconcile (run store). */
	readReceipt(runId: string): RunMetadataV1 | null;
	/** Injected for testability (defaults to run-store isPidAlive). */
	isPidAlive?: (pid: number) => boolean;
	/** R15: optional footer hook — live background count changes. */
	onInventoryChange?: (liveCount: number) => void;
}

interface ManagedRun {
	handle: BackgroundRunHandle;
	generation: number;
	/** Set when the owning branch is not the active one (delivery deferred). */
	detached: boolean;
	done: boolean;
}

/**
 * R9/R10/R12/R13: slot accounting, ledger writes, serialized delivery,
 * generation guard, tree pause, reconcile.
 */
export class BackgroundManager {
	readonly #ports: BackgroundManagerPorts;
	readonly #runs = new Map<string, ManagedRun>();
	#generation = 0;
	#paused = false;
	#deliveryTail: Promise<void> = Promise.resolve();
	#pendingFlush: Array<() => void> = [];
	/** runIds with a created entry on the currently active branch. */
	#branchOwned = new Set<string>();
	/** Latest branch snapshot (for dedup scans between refreshes). */
	#branchSnapshot: readonly SessionEntryLike[] = [];
	/** Delivered during this manager lifetime (in-memory dedup supplement). */
	#delivered = new Set<string>();
	readonly #isPidAlive: (pid: number) => boolean;

	constructor(ports: BackgroundManagerPorts) {
		this.#ports = ports;
		this.#isPidAlive = ports.isPidAlive ?? isPidAlive;
	}

	// ── Slots (R9) ────────────────────────────────────────────────────────

	private liveCount(): number {
		let n = 0;
		for (const run of this.#runs.values()) if (!run.done) n += 1;
		return n;
	}

	/** Sync pre-spawn slot check; null = a slot is free. */
	slotError(): DelegateError | null {
		const live = this.liveCount();
		if (live >= this.#ports.maxBackgroundRuns()) {
			return {
				code: "E_BACKGROUND_FULL",
				message: `${live} background runs active (limit ${this.#ports.maxBackgroundRuns()}); wait for terminal reports or check delegate_status.`,
			};
		}
		return null;
	}

	// ── Registration + terminal path (R8/R10/R11) ─────────────────────────

	/** Register a spawned handle: ledger `created`, completion wiring. */
	register(handle: BackgroundRunHandle): void {
		const generation = this.#generation;
		this.#runs.set(handle.runId, { handle, generation, detached: false, done: false });
		this.#branchOwned.add(handle.runId);
		this.appendLedger({
			v: 1,
			type: "created",
			runId: handle.runId,
			role: handle.role,
			description: handle.description,
			createdAt: new Date().toISOString(),
		});
		void handle.completion.then((result) => {
			this.onTerminal(handle.runId, result);
		});
		this.#ports.onInventoryChange?.(this.liveCount());
	}

	private onTerminal(runId: string, result: DelegateRunResult): void {
		const run = this.#runs.get(runId);
		if (!run) return; // unknown run: reconcile owns it
		run.done = true;
		this.#ports.onInventoryChange?.(this.liveCount());
		if (run.generation !== this.#generation) return; // stale session: receipt only
		if (!this.#branchOwned.has(runId) || run.detached) {
			// Owning branch inactive: no entry write, no delivery here.
			// R12 reconcile delivers when the branch re-activates.
			return;
		}
		this.finalizeAndDeliver(runId, run.handle.role, run.handle.description, result);
	}

	/** R10/R11: finished entry first, then exactly one result message. */
	private finalizeAndDeliver(runId: string, role: RoleName, description: string, result: DelegateRunResult): void {
		if (this.wasDelivered(runId)) return;
		this.appendLedger({
			v: 1,
			type: "finished",
			runId,
			state: result.details.state,
			finishedAt: result.details.finishedAt,
		});
		this.deliver({
			customType: BACKGROUND_RESULT_TYPE,
			content: formatBackgroundResultEnvelope(
				runId,
				role,
				description,
				result.details.state,
				this.#ports.formatRun(result),
			),
			display: true,
			details: { runId, role, state: result.details.state, description, kind: "result" },
		});
	}

	// ── Delivery (serialized, pausable; R10/R13) ──────────────────────────

	private deliver(message: {
		customType: string;
		content: string;
		display: true;
		details: Record<string, unknown>;
	}): void {
		const send = () => {
			this.#deliveryTail = this.#deliveryTail
				.catch(() => undefined)
				.then(() => {
					this.#ports.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
					this.#delivered.add(String(message.details.runId));
				});
		};
		if (this.#paused) this.#pendingFlush.push(send);
		else send();
	}

	private appendLedger(entry: BackgroundCreatedEntry | BackgroundFinishedEntry): void {
		try {
			this.#ports.appendEntry(BACKGROUND_LEDGER_TYPE, entry);
		} catch {
			// ledger write failure is diagnostic-only; the receipt remains
			// the durable record and reconcile re-derives the state.
		}
	}

	private wasDelivered(runId: string): boolean {
		return this.#delivered.has(runId) || wasResultDelivered(this.#branchSnapshot, runId);
	}

	// ── Lifecycle (R12/R13) ───────────────────────────────────────────────

	/** session_start: new generation, adopt the projected branch. */
	start(branch: readonly SessionEntryLike[]): { resent: string[]; notes: string[] } {
		this.#generation += 1;
		this.#paused = false;
		for (const run of this.#runs.values()) {
			// Runs from a previous session of this process are stale for
			// direct delivery; reconcile re-adopts those the new branch owns.
			run.generation = -1;
			run.detached = true;
		}
		return this.reconcile(branch);
	}

	/** session_before_tree: pause delivery (buffered until afterTree). */
	beforeTree(): void {
		this.#paused = true;
	}

	/** session_tree: re-adopt the new branch, resume delivery. */
	afterTree(branch: readonly SessionEntryLike[]): { resent: string[]; notes: string[] } {
		this.#paused = false;
		const result = this.reconcile(branch);
		const pending = this.#pendingFlush;
		this.#pendingFlush = [];
		for (const flush of pending) flush();
		return result;
	}

	/** session_shutdown (R13): cancel every live child; no ledger writes. */
	shutdown(): void {
		this.#generation += 1;
		this.#paused = true;
		for (const run of this.#runs.values()) {
			if (!run.done) run.handle.cancel("cancelled");
		}
	}

	/**
	 * R12: rebuild ownership from the branch, deliver undelivered terminals
	 * exactly once, report foreign/live runs without touching them.
	 */
	reconcile(branch: readonly SessionEntryLike[]): { resent: string[]; notes: string[] } {
		this.#branchSnapshot = branch;
		const { records, skipped } = projectBackgroundRuns(branch);
		this.#branchOwned = new Set(records.keys());
		const resent: string[] = [];
		const notes: string[] = [];
		if (skipped > 0) notes.push(`${skipped} malformed delegate.background entr${skipped === 1 ? "y" : "ies"} skipped`);

		for (const [runId, record] of records) {
			const managed = this.#runs.get(runId);
			if (managed && !managed.done) {
				// Live child of this process: re-adopt for the new branch.
				managed.generation = this.#generation;
				managed.detached = false;
				continue;
			}
			if (record.finished) {
				if (!this.wasDelivered(runId)) {
					const receipt = this.#ports.readReceipt(runId);
					if (receipt) {
						this.deliverResultFromReceipt(runId, record, receipt);
						resent.push(runId);
					} else {
						notes.push(`run ${runId}: finished entry but receipt purged; session JSONL is the record`);
					}
				}
				continue;
			}
			// created, not finished: check the receipt.
			const receipt = this.#ports.readReceipt(runId);
			if (!receipt) {
				notes.push(`run ${runId}: no receipt (purged); nothing to reconcile`);
				continue;
			}
			if (isTerminalRunState(receipt.state)) {
				// Finished while its branch was inactive (or crash between
				// receipt finalization and the ledger write): append the
				// missing finished entry, then deliver once.
				if (!this.wasDelivered(runId)) {
					this.appendLedger({
						v: 1,
						type: "finished",
						runId,
						state: receipt.state,
						finishedAt: receipt.finishedAt ?? new Date().toISOString(),
					});
					this.deliverResultFromReceipt(runId, record, receipt);
					resent.push(runId);
				}
				continue;
			}
			if (typeof receipt.pid === "number" && this.#isPidAlive(receipt.pid)) {
				notes.push(`run ${runId}: nonterminal, owned by another live session (pid ${receipt.pid}) — not touched`);
				continue;
			}
			// Nonterminal, dead pid: children die with the parent process;
			// markOrphanedRuns (startup) finalized the receipt as crashed.
			const refreshed = this.#ports.readReceipt(runId);
			if (refreshed && isTerminalRunState(refreshed.state) && !this.wasDelivered(runId)) {
				this.appendLedger({
					v: 1,
					type: "finished",
					runId,
					state: refreshed.state,
					finishedAt: refreshed.finishedAt ?? new Date().toISOString(),
				});
				this.deliverResultFromReceipt(runId, record, refreshed);
				resent.push(runId);
			}
		}
		return { resent, notes };
	}

	private deliverResultFromReceipt(
		runId: string,
		record: BackgroundRunRecord,
		receipt: RunMetadataV1,
	): void {
		const role = record.created.role;
		const description = record.created.description;
		const result = receiptToRunResult(receipt);
		this.deliver({
			customType: BACKGROUND_RESULT_TYPE,
			content: formatBackgroundResultEnvelope(
				runId,
				role,
				description,
				result.details.state,
				this.#ports.formatRun(result),
			),
			display: true,
			details: { runId, role, state: result.details.state, description, kind: "result" },
		});
	}

	// ── Introspection (status surface, R14 lands in M2) ───────────────────

	liveRuns(): Array<{ runId: string; role: RoleName; description: string; detached: boolean }> {
		return [...this.#runs.values()]
			.filter((r) => !r.done)
			.map((r) => ({ runId: r.handle.runId, role: r.handle.role, description: r.handle.description, detached: r.detached }));
	}

	/** Cancel one background run (user path). */
	cancel(runId: string): boolean {
		const run = this.#runs.get(runId);
		if (!run || run.done) return false;
		run.handle.cancel("cancelled");
		return true;
	}

	/** R16: steer one live background run (RPC follow_up). */
	send(runId: string, message: string): { ok: true } | { ok: false; error: string } {
		const run = this.#runs.get(runId);
		if (!run) {
			return {
				ok: false,
				error: `unknown or expired background run ${runId}. It is not a live background run of this session (foreground runs cannot be steered — the parent turn is blocked on them; finished runs continue via delegate({ resumeFrom: … })).`,
			};
		}
		if (run.done) {
			return { ok: false, error: `background run ${runId} already finished; continue it with delegate({ resumeFrom: "${runId}", … }) instead.` };
		}
		if (!run.handle.steer) {
			return { ok: false, error: `background run ${runId} does not support steering.` };
		}
		return run.handle.steer(message);
	}
}

// ── R14: status text builders (pure; the adapter feeds data in) ────────

export interface BackgroundLiveView {
	runId: string;
	role: RoleName;
	description: string;
	phase?: string;
	elapsedMs?: number;
	openTools?: string[];
	model?: string;
	detached?: boolean;
}

export interface BackgroundRecentView {
	runId: string;
	role: RoleName;
	description?: string;
	state: RunTerminalState;
	durationMs?: number;
}

export function formatBackgroundInventoryText(data: {
	limit: number;
	live: BackgroundLiveView[];
	queue: number;
	recent: BackgroundRecentView[];
}): string {
	const lines: string[] = [];
	const live = data.live;
	lines.push(`background: ${live.length}/${data.limit} slots active${data.queue > 0 ? ` · queue ${data.queue}` : ""}`);
	for (const r of live) {
		const bits = [r.runId, r.role, r.description];
		if (r.phase) bits.push(r.phase);
		if (r.elapsedMs !== undefined) bits.push(`${Math.round(r.elapsedMs / 1000)}s`);
		if (r.openTools?.length) bits.push(`⏳ ${r.openTools.slice(0, 2).join(",")}`);
		if (r.detached) bits.push("(branch inactive)");
		lines.push(`  · ${bits.join(" · ")}`);
	}
	if (live.length === 0) lines.push("  · none");
	for (const r of data.recent.slice(0, 3)) {
		lines.push(`  last: ${r.runId} ${r.role} ${backgroundStateWord(r.state)}${r.durationMs != null ? ` in ${Math.round(r.durationMs / 1000)}s` : ""}`);
	}
	return lines.join("\n");
}

export interface BackgroundDetailView {
	runId: string;
	role: RoleName;
	description?: string;
	state: RunState | RunTerminalState;
	model?: string;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	live?: { phase: string; elapsedMs: number; openTools?: string[] };
	activityTail: string[];
	handoffPreview?: string;
	sessionPath?: string;
	background: boolean;
}

export function formatBackgroundDetailText(d: BackgroundDetailView): string {
	const lines = [`[delegate background ${d.runId}]`];
	const state = isTerminalRunState(d.state as RunTerminalState)
		? backgroundStateWord(d.state as RunTerminalState)
		: String(d.state);
	lines.push(`state: ${state} · role: ${d.role}${d.description ? ` · ${d.description}` : ""}`);
	if (d.model) lines.push(`model: ${d.model}`);
	if (d.live) {
		lines.push(`live: ${d.live.phase} · ${Math.round(d.live.elapsedMs / 1000)}s elapsed${d.live.openTools?.length ? ` · in flight: ${d.live.openTools.join(", ")}` : ""}`);
	} else if (d.durationMs != null) {
		lines.push(`duration: ${Math.round(d.durationMs / 1000)}s${d.finishedAt ? ` · finished ${d.finishedAt}` : ""}`);
	}
	if (d.activityTail.length > 0) {
		lines.push("", "recent activity:");
		for (const a of d.activityTail) lines.push(`  ${a}`);
	}
	if (d.handoffPreview) {
		lines.push("", "handoff (first lines):");
		for (const h of d.handoffPreview.split("\n").slice(0, 12)) lines.push(`  ${h}`);
	}
	if (isTerminalRunState(d.state as RunTerminalState) && d.state !== "succeeded" && d.sessionPath) {
		lines.push("", `resume: delegate({ resumeFrom: "${d.runId}" }) continues this run's child session.`);
	}
	return lines.join("\n");
}

/** R15: display text for a delivered background result message: neutral
 * glyph header + report body, with the model-only classification paragraph
 * stripped (never shown to the user). */
export function backgroundResultDisplay(content: string, details: { runId?: string; state?: string; description?: string }): string {
	const parts = content.split("\n\n");
	const body = parts.length > 2 ? parts.slice(2).join("\n\n") : content;
	const state = (details.state ?? "?") as RunTerminalState;
	const word = backgroundStateWord(state);
	const glyph = state === "succeeded" ? "✓" : state === "cancelled" ? "⊘" : state.startsWith("timed_out") ? "⏱" : "⚠";
	const runId = details.runId ?? "?";
	const desc = details.description ? ` · ${details.description}` : "";
	const bodyLines = body.split("\n");
	const head = bodyLines[0] ?? "";
	const shown = [head.split("\n")[0], ...bodyLines.slice(1)].join("\n").split("\n").slice(0, 14).join("\n");
	return `${glyph} background ${runId}${desc}: ${word}\n\n${shown}`;
}

/** Default receipt reader bound to an agentDir (used by the adapter). */
export function makeReceiptReader(agentDir: string): (runId: string) => RunMetadataV1 | null {
	return (runId) => {
		try {
			return readRunMetadata(agentDir, runId);
		} catch {
			return null;
		}
	};
}
