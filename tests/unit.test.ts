/**
 * delegate unit tests — config, commands/grammar, roles, strict mode,
 * RPC JSONL parser, handoff truncation, run-store persistence.
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DEFAULT_DELEGATE_CONFIG, normalizeConfig, loadConfig, saveConfig, atomicWriteJson } from "../config.ts";
import { parseDelegateCommand, validateTask, delegateCompletions } from "../commands.ts";
import { DELEGATE_ROLES, isRoleName, resolveRole, intersectRoleTools, rolePromptExists } from "../roles.ts";
import {
	newModeRuntime,
	replayModeEntries,
	applyReplayToRuntime,
	gateToolCall,
	syncStrictToolSet,
	resetBlockedCounters,
	enableStrict,
	disableStrict,
	STRICT_OVERLAY,
	STRICT_ACTIVE_TOOLS,
} from "../mode.ts";
import { RpcJsonlParser, classifyRpcRecord } from "../rpc-jsonl.ts";
import { truncateHandoff, buildChildArgs } from "../runner.ts";
import { makeRunId, openRun, readRunMetadata, updateRunMetadata, listRuns, markOrphanedRuns, enforceRetention, runPaths, appendTranscriptRecord } from "../run-store.ts";
import type { DelegateRequest, SessionEntryLike, ModeTransitionContext } from "../types.ts";

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `delegate-${prefix}-`));
}

// ── config ───────────────────────────────────────────────────────────────

test("config: defaults when no file", () => {
	const dir = tmpDir("cfg");
	const res = loadConfig(dir);
	assert.equal(res.recoveredFromCorrupt, false);
	assert.deepEqual(res.config, DEFAULT_DELEGATE_CONFIG);
});

test("config: clamps invalid values, reports unknown keys", () => {
	const dir = tmpDir("cfg");
	const p = path.join(dir, "delegate", "config.json");
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify({ maxResultBytes: 999, defaultRole: "wizard", bogusKey: true }));
	const res = loadConfig(dir);
	assert.equal(res.config.maxResultBytes, 1024); // clamped to configured floor
	assert.equal(res.config.defaultRole, "general");
	assert.deepEqual(res.unknownKeys, ["bogusKey"]);
});

test("config: corrupt file preserved as evidence, defaults returned", () => {
	const dir = tmpDir("cfg");
	const p = path.join(dir, "delegate", "config.json");
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, "{not json");
	const res = loadConfig(dir);
	assert.equal(res.recoveredFromCorrupt, true);
	assert.ok(res.corruptEvidencePath && fs.existsSync(res.corruptEvidencePath));
	assert.deepEqual(res.config, DEFAULT_DELEGATE_CONFIG);
});

test("config: atomic save round-trips, 0600 file", () => {
	const dir = tmpDir("cfg");
	saveConfig(dir, { ...DEFAULT_DELEGATE_CONFIG, maxResultBytes: 40000 });
	const p = path.join(dir, "delegate", "config.json");
	const res = loadConfig(dir);
	assert.equal(res.config.maxResultBytes, 40000);
	const mode = fs.statSync(p).mode & 0o777;
	assert.equal(mode, 0o600);
});

test("atomicWriteJson: no temp leftovers", () => {
	const dir = tmpDir("atomic");
	const p = path.join(dir, "x.json");
	atomicWriteJson(p, { a: 1 });
	assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")), { a: 1 });
	const strays = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
	assert.equal(strays.length, 0);
});

// ── commands / grammar ───────────────────────────────────────────────────

test("grammar: reserved subcommands beat task fallback", () => {
	assert.deepEqual(parseDelegateCommand("status"), { kind: "status" });
	assert.deepEqual(parseDelegateCommand("on"), { kind: "enable" });
	assert.deepEqual(parseDelegateCommand("off"), { kind: "disable" });
	assert.deepEqual(parseDelegateCommand("doctor"), { kind: "doctor" });
	assert.deepEqual(parseDelegateCommand("paths"), { kind: "paths" });
	assert.deepEqual(parseDelegateCommand("help"), { kind: "help" });
	assert.deepEqual(parseDelegateCommand(""), { kind: "dashboard" });
});

test("grammar: run/research/shorthand", () => {
	const r = parseDelegateCommand("run research read the spec and summarize");
	assert.equal(r.kind, "run");
	if (r.kind === "run") {
		assert.equal(r.role, "research");
		assert.equal(r.task, "read the spec and summarize");
	}
	const s = parseDelegateCommand("summarize README.md");
	assert.equal(s.kind, "run");
	if (s.kind === "run") {
		assert.equal(s.role, "general");
		assert.equal(s.explicit, false);
	}
	const g = parseDelegateCommand("run general fix the flaky test");
	if (g.kind === "run") {
		assert.equal(g.role, "general");
		assert.equal(g.explicit, true);
	}
});

test("grammar: cancel/inspect default runId undefined", () => {
	assert.deepEqual(parseDelegateCommand("cancel"), { kind: "cancel", runId: undefined });
	assert.deepEqual(parseDelegateCommand("inspect del_123"), { kind: "inspect", runId: "del_123" });
});

test("grammar: invalid subcommands and empty tasks rejected; unknown words are shorthand", () => {
	assert.equal(parseDelegateCommand("wat").kind, "run"); // shorthand → general
	assert.equal((parseDelegateCommand("wat") as { role?: string }).role, "general");
	assert.equal(parseDelegateCommand("run").kind, "invalid");
	assert.equal(parseDelegateCommand("research").kind, "invalid");
	const vt = validateTask("   ", 1000);
	assert.notEqual(typeof vt, "string");
	assert.equal(validateTask("ok", 1000), "ok");
});

test("grammar: CRLF normalized, byte limit enforced", () => {
	const t = validateTask("a\r\nb", 1000);
	assert.equal(typeof t, "string");
	if (typeof t === "string") assert.ok(!t.includes("\r"));
	const big = validateTask("x".repeat(100), 50);
	assert.notEqual(typeof big, "string");
});

test("completions: reserved prefixes and run ids", () => {
	const items = delegateCompletions("re", ["del_abc"]);
	assert.ok(items.some((i) => i.startsWith("research")));
	const items2 = delegateCompletions("ru", ["del_abc"]);
	assert.ok(items2.some((i) => i.startsWith("run")));
	const ids = delegateCompletions("inspect del_", ["del_abc", "del_xyz", "other"]);
	assert.ok(ids.some((i) => i.includes("del_abc")));
});

// ── roles ────────────────────────────────────────────────────────────────

test("roles: closed catalogue, ceilings, prompt assets", () => {
	assert.deepEqual(Object.keys(DELEGATE_ROLES).sort(), ["general", "research"]);
	assert.equal(isRoleName("general"), true);
	assert.equal(isRoleName("coding"), false);
	assert.equal(isRoleName("wizard"), false);
	const research = resolveRole("research", "general");
	assert.equal(research.name, "research");
	// Research is read-only: no write-capable tools in ceiling.
	for (const tool of research.tools) {
		assert.equal(tool === "edit" || tool === "write" || tool === "bash", false);
	}
	assert.equal(rolePromptExists(DELEGATE_ROLES.general), true);
	assert.equal(rolePromptExists(DELEGATE_ROLES.research), true);
	assert.equal(intersectRoleTools(research, ["mcp__firecrawl", "bash"]).includes("bash"), false);
});

// ── strict mode ──────────────────────────────────────────────────────────

function modeCtx(overrides: Partial<ModeTransitionContext> = {}): ModeTransitionContext & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		isBusy: () => false,
		requestAbortConfirmation: async () => true,
		abort: () => calls.push("abort"),
		waitForIdle: async () => {},
		getActiveTools: () => (calls.includes("setActiveTools:[delegate]") ? ["delegate"] : ["read", "bash"]),
		setActiveTools: (tools) => calls.push(`setActiveTools:[${tools.join(",")}]`),
		persistModeEntry: () => calls.push("persist"),
		setFooterStatus: () => {},
		notify: () => {},
		...overrides,
	};
}

function modeEntry(enabled: boolean, at = new Date().toISOString()): SessionEntryLike {
	return { type: "custom", customType: "delegate-mode", data: { schemaVersion: 1, enabled, changedAt: at, source: "command" } } as unknown as SessionEntryLike;
}

test("mode: replay last-valid-wins; corrupt never implies permissive", () => {
	const r1 = replayModeEntries([modeEntry(true), modeEntry(false)]);
	assert.equal(r1.modeEnabled, false);
	assert.equal(r1.diagnostics.length, 0);
	const corrupt = { type: "custom", customType: "delegate-mode", data: { schemaVersion: 2, enabled: false } } as unknown as SessionEntryLike;
	const r2 = replayModeEntries([modeEntry(true), corrupt]);
	assert.equal(r2.modeEnabled, true); // last VALID wins…
	assert.ok(r2.diagnostics.length > 0); // …never silently
	const rt = newModeRuntime();
	applyReplayToRuntime(rt, r2);
	assert.equal(rt.modeEnabled, true);
});

test("mode: headless enable fails closed when busy", async () => {
	const rt = newModeRuntime();
	const ctx = modeCtx({ isBusy: () => true, requestAbortConfirmation: async () => false });
	const res = await enableStrict(rt, ctx);
	assert.equal(res.ok, false);
	assert.equal(res.code, "E_PARENT_BUSY");
	assert.equal(rt.modeEnabled, false);
});

test("mode: busy enable aborts only after confirmation", async () => {
	const rt = newModeRuntime();
	const ctx = modeCtx({ isBusy: () => true });
	const res = await enableStrict(rt, ctx);
	assert.equal(res.ok, true);
	assert.ok(ctx.calls.includes("abort"), "abort only after explicit confirmation");
	assert.ok(ctx.calls.includes("persist"));
	assert.equal(rt.modeEnabled, true);
});

test("mode: enable pins active tools to delegate and persists", async () => {
	const rt = newModeRuntime();
	const ctx = modeCtx();
	const res = await enableStrict(rt, ctx);
	assert.equal(res.ok, true);
	assert.ok(ctx.calls.includes("setActiveTools:[delegate]"));
	assert.ok(ctx.calls.includes("persist"));
});

test("mode: disable restores parent baseline tools", async () => {
	const rt = newModeRuntime();
	const ctx = modeCtx();
	await enableStrict(rt, ctx);
	const res = await disableStrict(rt, ctx);
	assert.equal(res.ok, true);
	assert.ok(ctx.calls.includes("setActiveTools:[read,bash]"));
	assert.equal(rt.modeEnabled, false);
});

test("mode: persistence failure keeps runtime state, flags degraded", async () => {
	const rt = newModeRuntime();
	const ctx = modeCtx({
		persistModeEntry: () => {
			throw new Error("disk on fire");
		},
	});
	const res = await enableStrict(rt, ctx);
	assert.equal(res.ok, true); // activation succeeds…
	assert.equal(rt.persistenceDegraded, true); // …but honestly flagged
});

test("mode: fail-closed allowlist gate", () => {
	const rt = newModeRuntime();
	applyReplayToRuntime(rt, replayModeEntries([modeEntry(true)]));
	assert.equal(gateToolCall(rt, "delegate").block, false);
	assert.equal(gateToolCall(rt, "read").block, true);
	assert.equal(gateToolCall(rt, "bash").block, true);
	assert.equal(gateToolCall(rt, "mcp__firecrawl").block, true);
	assert.equal(gateToolCall(rt, undefined).block, true);
	assert.equal(gateToolCall(rt, 42).block, true);
	// normal mode: everything passes
	const rt2 = newModeRuntime();
	applyReplayToRuntime(rt2, replayModeEntries([]));
	assert.equal(gateToolCall(rt2, "bash").block, false);
});

test("mode: blocked reasons include user unblock hint", () => {
	const rt = newModeRuntime();
	applyReplayToRuntime(rt, replayModeEntries([modeEntry(true)]));
	const d = gateToolCall(rt, "bash");
	assert.equal(d.block, true);
	assert.ok((d.reason ?? "").includes("/delegate off"));
});

test("mode: drift repair restores ['delegate']", () => {
	const rt = newModeRuntime();
	applyReplayToRuntime(rt, replayModeEntries([modeEntry(true)]));
	let applied = 0;
	const repaired = syncStrictToolSet(rt, ["read", "bash"], () => {
		applied += 1;
	});
	assert.equal(repaired, true);
	assert.equal(applied, 1);
	resetBlockedCounters(rt);
	const again = syncStrictToolSet(rt, STRICT_ACTIVE_TOOLS, () => {});
	assert.equal(again, false);
});

test("mode: overlay injected exactly once (idempotent)", () => {
	const prompt = "base prompt";
	const withOverlay = `${prompt}\n\n${STRICT_OVERLAY}`;
	assert.equal(withOverlay.includes("[DELEGATION-MODE OVERLAY"), true);
	const again = withOverlay.includes("[DELEGATION-MODE OVERLAY") ? withOverlay : `${withOverlay}\n\n${STRICT_OVERLAY}`;
	assert.equal((again.match(/DELEGATION-MODE OVERLAY/g) ?? []).length, 1);
});

test("mode: branch replay independence (session_tree / resume)", () => {
	const branchA = [modeEntry(true)];
	const branchB: SessionEntryLike[] = [];
	const rt = newModeRuntime();
	applyReplayToRuntime(rt, replayModeEntries(branchA));
	assert.equal(rt.modeEnabled, true);
	applyReplayToRuntime(rt, replayModeEntries(branchB));
	assert.equal(rt.modeEnabled, false);
});

// ── RPC JSONL parser ─────────────────────────────────────────────────────

test("parser: LF framing with CRLF tolerance and CR strip", () => {
	const p = new RpcJsonlParser();
	const recs = p.feed(Buffer.from('{"type":"agent_settled"}\r\n{"type":"agent_end"}\n'));
	assert.equal(recs.length, 2);
	assert.equal(recs[0]!.raw.toString(), '{"type":"agent_settled"}');
	assert.equal(recs[1]!.raw.toString(), '{"type":"agent_end"}');
});

test("parser: incomplete buffer retained across chunks", () => {
	const p = new RpcJsonlParser();
	assert.equal(p.feed(Buffer.from('{"type":"a')).length, 0);
	const recs = p.feed(Buffer.from('gent_settled"}\n'));
	assert.equal(recs.length, 1);
	assert.deepEqual((recs[0]!.parsed as { type: string }).type, "agent_settled");
});

test("parser: U+2028/U+2029 inside strings preserved as data", () => {
	const p = new RpcJsonlParser();
	const raw = JSON.stringify({ type: "x", text: "line\u2028sep\u2029end" });
	const recs = p.feed(Buffer.from(`${raw}\n`, "utf8"));
	assert.equal(recs.length, 1);
	assert.equal((recs[0]!.parsed as { text: string }).text, "line\u2028sep\u2029end");
	assert.equal(recs[0]!.malformed, false);
});

test("parser: malformed captured, threshold exceeded", () => {
	const p = new RpcJsonlParser({ malformedThreshold: 2 });
	const recs = p.feed(Buffer.from("garbage1\nnot json {\ngarbage3\n"));
	assert.equal(recs.filter((r) => r.malformed).length, 3);
	assert.equal(p.malformedRecords, 3);
	assert.equal(p.exceededMalformedThreshold, true);
});

test("parser: oversize record flagged", () => {
	const p = new RpcJsonlParser({ maxRecordBytes: 8 });
	const recs = p.feed(Buffer.from('{"type":"tool_execution_start","toolName":"bash"}\n'));
	assert.equal(recs[0]!.malformed, true);
	assert.equal(p.oversized, true);
});

test("parser: close flushes complete final record lacking LF", () => {
	const p = new RpcJsonlParser();
	const r1 = p.feed(Buffer.from('{"type":"y"}'));
	assert.equal(r1.length, 0); // no LF yet — retained in buffer
	const recs = p.close();
	assert.equal(recs.length, 1);
	assert.equal(recs[0]!.malformed, false);
	// genuinely incomplete JSON is malformed but never dropped
	const p2 = new RpcJsonlParser();
	p2.feed(Buffer.from('{"type":"y"'));
	const recs2 = p2.close();
	assert.equal(recs2.length, 1);
	assert.equal(recs2[0]!.malformed, true);
});

test("classify: all event kinds", () => {
	const mk = (parsed: unknown) => ({ raw: Buffer.from(""), parsed, malformed: false });
	assert.equal(classifyRpcRecord(mk({ type: "prompt_response" }) as never).kind, "unknown"); // shape is type:"response"
	assert.equal(classifyRpcRecord(mk({ type: "response", id: "d1:prompt" }) as never).kind, "prompt_response");
	assert.equal((classifyRpcRecord(mk({ type: "response", id: "d1:prompt", error: "nope" }) as never) as { ok?: boolean }).ok, false);
	assert.equal(classifyRpcRecord(mk({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }) as never).kind, "message_end");
	assert.equal(classifyRpcRecord(mk({ type: "tool_execution_start", toolName: "read" }) as never).kind, "tool_event");
	assert.equal(classifyRpcRecord(mk({ type: "agent_settled" }) as never).kind, "agent_settled");
	assert.equal(classifyRpcRecord(mk({ type: "agent_end" }) as never).kind, "agent_end");
	assert.equal(classifyRpcRecord(mk({ type: "extension_ui_request", id: "u1" }) as never).kind, "extension_ui_request");
	assert.equal(classifyRpcRecord(mk({ type: "extension_error" }) as never).kind, "extension_error");
	assert.equal(classifyRpcRecord(mk({ type: "totally_new_event" }) as never).kind, "unknown");
	assert.equal(classifyRpcRecord({ raw: Buffer.from("x"), parsed: null, malformed: true }).kind, "malformed");
});

// ── handoff truncation ───────────────────────────────────────────────────

test("truncate: under budget unchanged", () => {
	const r = truncateHandoff("hello", 1000);
	assert.equal(r.text, "hello");
	assert.equal(r.truncated, false);
});

test("truncate: 75/25 head-tail with marker, UTF-8 safe", () => {
	const text = "日本語テキスト".repeat(100); // multi-byte
	const r = truncateHandoff(text, 200);
	assert.equal(r.truncated, true);
	assert.ok(r.text.includes("truncated"));
	// valid UTF-8 round-trip
	assert.equal(Buffer.from(r.text, "utf8").toString("utf8"), r.text);
	assert.ok(Buffer.byteLength(r.text, "utf8") <= 200 + 64);
	const headPart = r.text.split("…")[0] ?? "";
	assert.ok(text.startsWith(headPart.replace("\n", "")));
});

// ── child argv builder ───────────────────────────────────────────────────

test("child args: task never in argv; rpc/no-session/model/tools present", () => {
	const role = resolveRole("research", "general");
	const { args } = buildChildArgs(
		{
			agentDir: "/x",
			role,
			task: "SECRET TASK TEXT",
			runId: "del_test",
			parentModel: "lm/studio",
			cwd: "/x",
			projectTrusted: true,
			registeredTools: ["mcp__firecrawl"],
		},
		role,
	);
	assert.equal(args.some((a) => a.includes("SECRET TASK TEXT")), false);
	assert.ok(args.includes("--mode") && args.includes("rpc"));
	assert.ok(args.includes("--no-session"));
	assert.ok(args.includes("--model"));
	assert.ok(args.includes("--tools"));
	assert.ok(!args.some((a) => a === "--auto-approve"));
});

// ── run store ────────────────────────────────────────────────────────────

test("store: run id format del_<ts>_<hex>", () => {
	const id = makeRunId(new Date("2026-09-01T14:30:22Z"));
	assert.match(id, /^del_20260901T143022Z_[0-9a-f]{8}$/);
});

function req(task = "do it"): DelegateRequest {
	return { task, role: "general", source: "tool", cwd: process.cwd(), parentModel: "lm/studio", projectTrusted: true };
}

test("store: openRun creates 0700 dir / 0600 files; transcript append-only", async () => {
	const dir = tmpDir("store");
	const opened = openRun(dir, req());
	const { paths } = opened;
	const dirMode = fs.statSync(path.dirname(paths.metadataPath)).mode & 0o777;
	assert.equal(dirMode, 0o700);
	appendTranscriptRecord(opened.stdout, 0, new Date().toISOString(), Buffer.from('{"type":"response","id":"d1:prompt"}'));
	appendTranscriptRecord(opened.stdout, 1, new Date().toISOString(), Buffer.from('{"type":"agent_settled"}'));
	opened.stdout.end();
	opened.stderr.end();
	await new Promise((r) => setTimeout(r, 100));
	for (const f of [paths.metadataPath, paths.transcriptPath, paths.stderrPath]) {
		assert.equal(fs.statSync(f).mode & 0o777, 0o600, `mode wrong for ${f}`);
	}
	const lines = fs.readFileSync(paths.transcriptPath, "utf8").trim().split("\n");
	assert.equal(lines.length, 2);
	assert.equal(JSON.parse(lines[1]!).sequence, 1);
});

test("store: metadata updates, terminal fields, corrupt read null", () => {
	const dir = tmpDir("store");
	const opened = openRun(dir, req());
	const runId = opened.metadata.runId;
	opened.stdout.end();
	opened.stderr.end();
	updateRunMetadata(dir, runId, (m) => ({ ...m, state: "running", startedAt: new Date().toISOString() }));
	const m1 = readRunMetadata(dir, runId);
	assert.equal(m1?.state, "running");
	updateRunMetadata(dir, runId, (m) => ({ ...m, state: "succeeded", finishedAt: new Date().toISOString() }));
	const m2 = readRunMetadata(dir, runId);
	assert.equal(m2?.state, "succeeded");
	assert.ok(m2?.finishedAt);
	// corrupt metadata surfaces as null (evidence kept)
	fs.writeFileSync(runPaths(dir, runId).metadataPath, "{broken");
	assert.equal(readRunMetadata(dir, runId), null);
});

test("store: orphan recovery marks nonterminal without owned child", () => {
	const dir = tmpDir("store");
	const opened = openRun(dir, req());
	opened.stdout.end();
	opened.stderr.end();
	// running with pid of a dead process
	updateRunMetadata(dir, opened.metadata.runId, (m) => ({ ...m, state: "running", pid: 999999 }));
	const marked = markOrphanedRuns(dir);
	assert.ok(marked.includes(opened.metadata.runId));
	const m = readRunMetadata(dir, opened.metadata.runId);
	assert.equal(m?.state, "crashed");
	assert.equal(m?.errorCode, "E_ORPHANED_RUN");
});

test("store: retention keeps newest N plus active", () => {
	const dir = tmpDir("store");
	const ids: string[] = [];
	for (let i = 0; i < 6; i++) {
		const o = openRun(dir, req(`task ${i}`));
		o.stdout.end();
		o.stderr.end();
		updateRunMetadata(dir, o.metadata.runId, (m) => ({ ...m, state: "succeeded", finishedAt: new Date().toISOString() }));
		ids.push(o.metadata.runId);
	}
	const kept = enforceRetention(dir, 3, 30, undefined);
	assert.equal(fs.existsSync(runPaths(dir, ids[5]!).metadataPath), true);
	assert.equal(fs.existsSync(runPaths(dir, ids[0]!).metadataPath), false);
	assert.ok(kept.removed >= 3);
});

test("store: listRuns sorted newest first with summaries", () => {
	const dir = tmpDir("store");
	for (let i = 0; i < 3; i++) {
		const o = openRun(dir, req(`t${i}`));
		o.stdout.end();
		o.stderr.end();
		updateRunMetadata(dir, o.metadata.runId, (m) => ({ ...m, state: "succeeded", finishedAt: new Date().toISOString() }));
	}
	const runs = listRuns(dir, 10);
	assert.equal(runs.length, 3);
	assert.ok(runs[0]!.mtimeMs >= runs[2]!.mtimeMs);
});

// ── formatRunSummary (expanded TUI view) ─────────────────────────────────

test("summary: structured handoff keeps Outcome + 2 lines per other section", async () => {
	const { formatRunSummary } = await import("../index.ts");
	const res = {
		ok: true,
		handoff: [
			"## Outcome", "did the thing",
			"",
			"## Changes", "- a.ts: x", "- b.ts: y", "- c.ts: z",
			"",
			"## Verification", "- npm test passed", "- typecheck passed", "- lint passed",
			"",
			"## Risks and open questions", "none",
		].join("\n"),
		details: {
			displayItems: [{ type: "text", text: "bash npm test" }],
			outputTruncated: false,
			stderrPath: "",
			transcriptPath: "/tmp/t.jsonl",
		},
	} as never;
	const out = formatRunSummary(res);
	assert.ok(out.includes("## Outcome\ndid the thing"));
	assert.ok(out.includes("- a.ts: x") && out.includes("- b.ts: y") && !out.includes("- c.ts: z"));
	assert.ok(out.includes("bash npm test"));
});

test("summary: unstructured handoff falls back to first lines", async () => {
	const { formatRunSummary } = await import("../index.ts");
	const res = {
		ok: true,
		handoff: "line1\nline2\nline3",
		details: { displayItems: [], outputTruncated: false, stderrPath: "", transcriptPath: "/tmp/t.jsonl" },
	} as never;
	const out = formatRunSummary(res);
	assert.ok(out.startsWith("line1\nline2\nline3"));
});

test("summary: failure shows error code", async () => {
	const { formatRunSummary } = await import("../index.ts");
	const res = {
		ok: false,
		handoff: "",
		error: { code: "E_CHILD_MODEL", message: "model exploded" },
		details: { displayItems: [], outputTruncated: false, stderrPath: "", transcriptPath: "/tmp/t.jsonl" },
	} as never;
	assert.ok(formatRunSummary(res).includes("E_CHILD_MODEL: model exploded"));
});

test("summary: maxLines caps output with a trailer", async () => {
	const { formatRunSummary } = await import("../index.ts");
	const res = {
		ok: true,
		handoff: "## Outcome\n" + Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
		details: { displayItems: [], outputTruncated: false, stderrPath: "", transcriptPath: "/tmp/t.jsonl" },
	} as never;
	const out = formatRunSummary(res, { maxLines: 14 });
	assert.ok(out.endsWith("more lines — see transcript)"));
	assert.equal(out.split("\n").length, 14);
});
