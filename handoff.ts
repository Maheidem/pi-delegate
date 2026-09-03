/**
 * delegate — the mandatory structured handoff contract (child → parent).
 *
 * Principle: anything the harness NEEDS from a model must be a validated
 * protocol step, never free text we hope has the right shape. The child's
 * final report is submitted through the `handoff` tool with this schema;
 * malformed submissions fail as tool errors and the child must retry, and a
 * child that settles without submitting is re-prompted (bounded) by the
 * runner before any free-text fallback is accepted.
 *
 * Pi-free: shared by the child-side tool registration (index.ts), the
 * runner's stream capture + renderer, and the tests.
 */

import { Type as t } from "typebox";

// ── Contract ──────────────────────────────────────────────────────────────

export const HANDOFF_OUTCOMES = ["done", "partial", "blocked"] as const;
export type HandoffOutcome = (typeof HANDOFF_OUTCOMES)[number];

export const HANDOFF_CHANGE_ACTIONS = ["created", "modified", "deleted"] as const;
export type HandoffChangeAction = (typeof HANDOFF_CHANGE_ACTIONS)[number];

export const HANDOFF_VERIFY_RESULTS = ["pass", "fail", "not_run"] as const;
export type HandoffVerifyResult = (typeof HANDOFF_VERIFY_RESULTS)[number];

export interface HandoffSubmission {
	outcome: HandoffOutcome;
	/** 1..2000 chars — the essential result statement. */
	summary: string;
	changes: Array<{ path: string; action: HandoffChangeAction; note?: string }>;
	verification: Array<{ command: string; result: HandoffVerifyResult; note?: string }>;
	/** Required when outcome is partial|blocked: precise next steps. */
	remaining: string[];
	risks: string[];
}

export interface HandoffValidation {
	ok: boolean;
	value?: HandoffSubmission;
	errors: string[];
}

const LIMITS = {
	summaryMax: 2000,
	listMax: 50,
	strMax: 500,
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function boundedString(v: unknown, max: number): string | null {
	const s = str(v);
	return s !== null && s.trim().length > 0 && s.length <= max ? s : null;
}

/**
 * Validate a raw handoff submission. Returns every problem found (the child
 * sees the full list and can fix all fields in one retry), plus the
 * normalized value on success.
 */
export function validateHandoffSubmission(input: unknown): HandoffValidation {
	const errors: string[] = [];
	if (!isRecord(input)) {
		return { ok: false, errors: ["handoff: submission must be an object with the handoff tool's fields"] };
	}

	// outcome
	const outcome = str(input.outcome);
	if (!(HANDOFF_OUTCOMES as readonly string[]).includes(outcome ?? "")) {
		errors.push(`handoff.outcome: must be one of ${HANDOFF_OUTCOMES.join("|")} (got ${JSON.stringify(input.outcome)})`);
	}

	// summary
	let summary = boundedString(input.summary, LIMITS.summaryMax);
	if (summary === null) {
		if (typeof input.summary === "string" && input.summary.trim()) {
			errors.push(`handoff.summary: ${input.summary.length} chars exceeds the ${LIMITS.summaryMax} limit`);
		} else {
			errors.push("handoff.summary: required, non-empty");
		}
	} else {
		summary = summary.trim();
	}

	// changes
	const changes: HandoffSubmission["changes"] = [];
	if (input.changes !== undefined) {
		if (!Array.isArray(input.changes)) {
			errors.push("handoff.changes: must be an array");
		} else if (input.changes.length > LIMITS.listMax) {
			errors.push(`handoff.changes: ${input.changes.length} entries exceeds the ${LIMITS.listMax} limit`);
		} else {
			input.changes.forEach((c, i) => {
				if (!isRecord(c)) {
					errors.push(`handoff.changes[${i}]: must be an object {path, action, note?}`);
					return;
				}
				const path = boundedString(c.path, LIMITS.strMax);
				if (!path) errors.push(`handoff.changes[${i}].path: required non-empty path`);
				const action = str(c.action);
				if (!(HANDOFF_CHANGE_ACTIONS as readonly string[]).includes(action ?? "")) {
					errors.push(`handoff.changes[${i}].action: must be one of ${HANDOFF_CHANGE_ACTIONS.join("|")}`);
				}
				if (path && action) {
					const note = boundedString(c.note ?? "", LIMITS.strMax);
					changes.push({
						path: path.trim(),
						action: action as HandoffChangeAction,
						...(note ? { note: note.trim() } : {}),
					});
				}
			});
		}
	}

	// verification
	const verification: HandoffSubmission["verification"] = [];
	if (input.verification !== undefined) {
		if (!Array.isArray(input.verification)) {
			errors.push("handoff.verification: must be an array");
		} else if (input.verification.length > LIMITS.listMax) {
			errors.push(`handoff.verification: ${input.verification.length} entries exceeds the ${LIMITS.listMax} limit`);
		} else {
			input.verification.forEach((v, i) => {
				if (!isRecord(v)) {
					errors.push(`handoff.verification[${i}]: must be an object {command, result, note?}`);
					return;
				}
				const command = boundedString(v.command, LIMITS.strMax);
				if (!command) errors.push(`handoff.verification[${i}].command: required non-empty`);
				const result = str(v.result);
				if (!(HANDOFF_VERIFY_RESULTS as readonly string[]).includes(result ?? "")) {
					errors.push(`handoff.verification[${i}].result: must be one of ${HANDOFF_VERIFY_RESULTS.join("|")}`);
				}
				if (command && result) {
					const note = boundedString(v.note ?? "", LIMITS.strMax);
					verification.push({
						command: command.trim(),
						result: result as HandoffVerifyResult,
						...(note ? { note: note.trim() } : {}),
					});
				}
			});
		}
	}

	// remaining — REQUIRED unless outcome is done
	const remaining: string[] = [];
	if (input.remaining !== undefined) {
		if (!Array.isArray(input.remaining)) {
			errors.push("handoff.remaining: must be an array of strings");
		} else if (input.remaining.length > LIMITS.listMax) {
			errors.push(`handoff.remaining: ${input.remaining.length} entries exceeds the ${LIMITS.listMax} limit`);
		} else {
			input.remaining.forEach((r, i) => {
				const s = boundedString(r, LIMITS.strMax);
				if (!s) errors.push(`handoff.remaining[${i}]: must be a non-empty string`);
				else remaining.push(s.trim());
			});
		}
	}
	if (outcome && outcome !== "done" && remaining.length === 0) {
		errors.push(`handoff.remaining: REQUIRED when outcome is '${outcome}' — list the precise next steps`);
	}

	// risks
	const risks: string[] = [];
	if (input.risks !== undefined) {
		if (!Array.isArray(input.risks)) {
			errors.push("handoff.risks: must be an array of strings");
		} else if (input.risks.length > LIMITS.listMax) {
			errors.push(`handoff.risks: ${input.risks.length} entries exceeds the ${LIMITS.listMax} limit`);
		} else {
			input.risks.forEach((r, i) => {
				const s = boundedString(r, LIMITS.strMax);
				if (!s) errors.push(`handoff.risks[${i}]: must be a non-empty string`);
				else risks.push(s.trim());
			});
		}
	}

	if (errors.length > 0 || !outcome || summary === null) {
		return { ok: false, errors };
	}
	return {
		ok: true,
		errors: [],
		value: { outcome: outcome as HandoffOutcome, summary, changes, verification, remaining, risks },
	};
}

/**
 * Deterministic renderer: the parent-facing handoff text is ALWAYS built
 * here from validated fields — never from model-formatted markdown.
 */
export function renderHandoff(h: HandoffSubmission, opts?: { partial?: boolean }): string {
	const lines: string[] = [];
	lines.push(`## Outcome (${h.outcome}${opts?.partial ? " · captured at kill" : ""})`);
	lines.push(h.summary);
	lines.push("", "## Changes");
	if (h.changes.length === 0) lines.push("none");
	else for (const c of h.changes) lines.push(`- ${c.action} ${c.path}${c.note ? ` — ${c.note}` : ""}`);
	lines.push("", "## Verification");
	if (h.verification.length === 0) lines.push("none run");
	else for (const v of h.verification) lines.push(`- ${v.result === "pass" ? "✓" : v.result === "fail" ? "✗" : "○"} ${v.command}${v.note ? ` — ${v.note}` : ""}`);
	if (h.remaining.length > 0) {
		lines.push("", "## Remaining");
		for (const r of h.remaining) lines.push(`- ${r}`);
	}
	lines.push("", "## Risks and open questions");
	if (h.risks.length === 0) lines.push("none");
	else for (const r of h.risks) lines.push(`- ${r}`);
	return lines.join("\n");
}

/** TypeBox parameter schema for the child-side `handoff` tool registration. */
export const HandoffToolParams = t.Object({
	outcome: t.Union(
		HANDOFF_OUTCOMES.map((o) => t.Literal(o)) as unknown as [ReturnType<typeof t.Literal>, ...Array<ReturnType<typeof t.Literal>>],
		{ description: "done | partial | blocked" },
	),
	summary: t.String({
		maxLength: LIMITS.summaryMax,
		description: "The essential result statement (required, 1-2000 chars)",
	}),
	changes: t.Optional(
		t.Array(
			t.Object({
				path: t.String({ maxLength: LIMITS.strMax }),
				action: t.Union(
					HANDOFF_CHANGE_ACTIONS.map((a) => t.Literal(a)) as unknown as [ReturnType<typeof t.Literal>, ...Array<ReturnType<typeof t.Literal>>],
				),
				note: t.Optional(t.String({ maxLength: LIMITS.strMax })),
			}),
			{ maxItems: LIMITS.listMax },
		),
	),
	verification: t.Optional(
		t.Array(
			t.Object({
				command: t.String({ maxLength: LIMITS.strMax }),
				result: t.Union(
					HANDOFF_VERIFY_RESULTS.map((r) => t.Literal(r)) as unknown as [ReturnType<typeof t.Literal>, ...Array<ReturnType<typeof t.Literal>>],
				),
				note: t.Optional(t.String({ maxLength: LIMITS.strMax })),
			}),
			{ maxItems: LIMITS.listMax },
		),
	),
	remaining: t.Optional(
		t.Array(t.String({ maxLength: LIMITS.strMax }), {
			maxItems: LIMITS.listMax,
			description: "REQUIRED when outcome is partial|blocked",
		}),
	),
	risks: t.Optional(t.Array(t.String({ maxLength: LIMITS.strMax }), { maxItems: LIMITS.listMax })),
});
