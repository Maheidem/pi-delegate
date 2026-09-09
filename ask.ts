/**
 * delegate — ask_parent channel (R17/R18): background children can ask the
 * parent blocking questions (answered via delegate_answer) and file
 * non-blocking notes. Child-side tool + shared validation; the parent-side
 * delivery lives in background.ts and the runner.
 *
 * Mechanism (SPEC §3): the tool call IS the blocking primitive. The child's
 * execute() polls $PI_DELEGATE_ASK_DIR/<toolCallId>.json until the parent's
 * answer lands or the budget expires. The runner watches the toolCall records
 * on the child stream and delivers the question/note message to the parent.
 */

import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_QUESTION_TYPE = "delegate-child-question";
export const CHILD_NOTE_TYPE = "delegate-child-note";

/** R17: the exact timeout fallback (byte-exact per SPEC §5 discipline). */
export const ASK_FALLBACK_TEXT =
	"No answer arrived within the budget. Proceed with your best judgment and state the assumption in your handoff.";

/** R18: notes are capped to bound spam (never blocks, never wakes). */
export const MAX_NOTES_PER_RUN = 20;

const QUESTION_TOPICS = ["blocked", "guidance", "approval", "opinion"] as const;
const NOTE_TOPICS = ["risk", "observation", "concern"] as const;

export const AskParentParams = Type.Object({
	kind: Type.Union([Type.Literal("question"), Type.Literal("note")], {
		description: "question = you are blocked and wait for the parent's answer; note = non-blocking FYI for the parent (no answer will come).",
	}),
	topic: Type.String({
		description: "question: blocked | guidance | approval | opinion. note: risk | observation | concern.",
	}),
	text: Type.String({
		minLength: 1,
		maxLength: 2000,
		description: "The question or note, ≤2000 chars. For questions: be specific and self-contained; the parent answers from its own context only.",
	}),
});

export type AskSubmission = {
	kind: "question" | "note";
	topic: string;
	text: string;
};

export function validateAskSubmission(params: unknown): { ok: true; value: AskSubmission } | { ok: false; errors: string[] } {
	if (!params || typeof params !== "object") return { ok: false, errors: ["ask_parent params must be an object."] };
	const raw = params as Record<string, unknown>;
	const errors: string[] = [];
	if (raw.kind !== "question" && raw.kind !== "note") errors.push("kind must be 'question' or 'note'.");
	const topic = typeof raw.topic === "string" ? raw.topic.trim() : "";
	if (!topic) errors.push("topic is required.");
	else if (raw.kind === "question" && !(QUESTION_TOPICS as readonly string[]).includes(topic)) {
		errors.push(`question topic must be one of: ${QUESTION_TOPICS.join(", ")}.`);
	} else if (raw.kind === "note" && !(NOTE_TOPICS as readonly string[]).includes(topic)) {
		errors.push(`note topic must be one of: ${NOTE_TOPICS.join(", ")}.`);
	}
	const text = typeof raw.text === "string" ? raw.text : "";
	if (!text.trim()) errors.push("text is required.");
	if (text.length > 2000) errors.push(`text must be ≤2000 chars (got ${text.length}).`);
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { kind: raw.kind as "question" | "note", topic, text } };
}

export interface AskEnv {
	askDir?: string;
	timeoutMs: number;
	maxQuestions: number;
	/** Test seam: sleep between polls. */
	sleep?: (ms: number) => Promise<void>;
	/** Test seam: inject the answer instead of reading the file. */
	readAnswer?: (toolCallId: string) => { answeredBy: string; answer: string } | null;
}

type AskToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: {
		rejected?: boolean;
		errors?: string[];
		askNote?: AskSubmission;
		askAnswered?: boolean;
		answeredBy?: string;
		askTimedOut?: boolean;
	};
	isError?: boolean;
};

/**
 * Child-side registration. The tool exists ONLY in background children
 * (PI_DELEGATE_ASK_DIR set by the runner when askParent is enabled):
 * a foreground child asking would deadlock the parent turn by construction.
 */
export function registerAskParentTool(pi: ExtensionAPI, env: AskEnv): void {
	const questionsAsked = { count: 0 };
	const notesFiled = { count: 0 };
	const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const readAnswer = env.readAnswer ?? ((toolCallId: string) => {
		const file = path.join(env.askDir ?? "", `${toolCallId}.json`);
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { answeredBy?: string; answer?: string };
			if (typeof raw.answer === "string") return { answeredBy: raw.answeredBy ?? "model", answer: raw.answer };
			return null;
		} catch {
			return null;
		}
	});
	pi.registerTool({
		name: "ask_parent",
		label: "Ask the parent",
		description:
			"Ask the delegating parent agent a question (you block until it answers or the budget expires) or file a non-blocking note. " +
			"Ask only when you are genuinely blocked or a wrong guess is expensive; for cheap decisions proceed with a stated assumption instead. " +
			"Prefer notes for risks and observations — they never stall your run.",
		parameters: AskParentParams,
		async execute(toolCallId: string, params): Promise<AskToolResult> {
			const validation = validateAskSubmission(params);
			if (!validation.ok) {
				return {
					content: [{ type: "text" as const, text: `ask_parent REJECTED — fix and call again:\n${validation.errors.map((e) => `- ${e}`).join("\n")}` }],
					details: { rejected: true, errors: validation.errors },
					isError: true,
				};
			}
			const ask = validation.value;
			if (ask.kind === "note") {
				if (notesFiled.count >= MAX_NOTES_PER_RUN) {
					return {
						content: [{ type: "text" as const, text: `Note cap reached (${MAX_NOTES_PER_RUN}). Continue your work; include remaining observations in your handoff.` }],
						details: { rejected: true },
						isError: true,
					};
				}
				notesFiled.count += 1;
				return {
					content: [{ type: "text" as const, text: `Note delivered to the parent (topic: ${ask.topic}). No answer will arrive — continue your work.` }],
					details: { askNote: ask },
				};
			}
			questionsAsked.count += 1;
			if (questionsAsked.count > env.maxQuestions) {
				return {
					content: [{ type: "text" as const, text: `Question budget exhausted (${env.maxQuestions} per run). ${ASK_FALLBACK_TEXT}` }],
					details: { rejected: true },
					isError: true,
				};
			}
			const deadline = Date.now() + env.timeoutMs;
			for (;;) {
				const answer = readAnswer(toolCallId);
				if (answer) {
					return {
						content: [{ type: "text" as const, text: `[parent answered · by ${answer.answeredBy}]\n${answer.answer}` }],
						details: { askAnswered: true, answeredBy: answer.answeredBy },
					};
				}
				if (Date.now() >= deadline) {
					return {
						content: [{ type: "text" as const, text: ASK_FALLBACK_TEXT }],
						details: { askTimedOut: true },
					};
				}
				await sleep(Math.min(400, Math.max(50, deadline - Date.now())));
			}
		},
	});
}

/** R17: answer payload written by the parent runner. */
export interface AskAnswerFile {
	answeredBy: "model" | "user";
	answeredAt: string;
	answer: string;
}

export function writeAskAnswerFile(askDir: string, toolCallId: string, payload: AskAnswerFile): void {
	fs.mkdirSync(askDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(askDir, `${toolCallId}.json`), JSON.stringify(payload), { mode: 0o600 });
}
