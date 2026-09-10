/**
 * delegate unit tests — config, commands/grammar, roles, strict mode,
 * RPC JSONL parser, handoff truncation, run-store persistence.
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { DEFAULT_DELEGATE_CONFIG, normalizeConfig, loadConfig, saveConfig, atomicWriteJson, loadConfigCascade, resolveRunTimeouts } from "../config.ts";
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
import { makeRunId, openRun, readRunMetadata, updateRunMetadata, listRuns, markOrphanedRuns, enforceRetention, runPaths, appendTranscriptRecord, isPidAlive, pidCommandLine, commandLineIsPi } from "../run-store.ts";
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
		getActiveTools: () => (calls.includes("setActiveTools:[delegate,delegate_status,delegate_send,delegate_answer]") ? ["delegate", "delegate_status", "delegate_send", "delegate_answer"] : ["read", "bash"]),
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
	assert.ok(ctx.calls.includes("setActiveTools:[delegate,delegate_status,delegate_send,delegate_answer]"));
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

test("child args: task never in argv; rpc/session-dir/model/tools present", () => {
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
	assert.ok(args.includes("--session-dir"));
	assert.ok(!args.includes("--no-session"), "sessions must be durable (R3)");
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

test("store: P1 detectors (isPidAlive / pidCommandLine / commandLineIsPi)", () => {
	assert.equal(isPidAlive(0), false);
	assert.equal(isPidAlive(-7), false);
	const deadPid = childProcess.spawnSync(process.execPath, ["-e", ""]).pid ?? -1;
	assert.ok(deadPid > 0);
	assert.equal(isPidAlive(deadPid), false, "exited pid must be dead");
	assert.equal(isPidAlive(process.pid), true, "own pid must be alive");
	assert.ok(commandLineIsPi("pi --mode rpc --session /tmp/x.jsonl"));
	assert.ok(commandLineIsPi("/opt/homebrew/bin/pi --mode rpc"));
	assert.ok(commandLineIsPi("node /opt/homebrew/bin/pi --mode rpc"));
	assert.ok(
		commandLineIsPi(
			"node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --mode rpc",
		),
	);
	assert.equal(commandLineIsPi("/bin/sleep 30"), false);
	assert.equal(commandLineIsPi("node /path/scripts/pi-mcp-server.mjs serve"), false);
});

test("store: P1 — live pi-cmdline owner is skipped; after death it is marked", async () => {
	const dir = tmpDir("p1-pi");
	const opened = openRun(dir, req());
	opened.stdout.end();
	opened.stderr.end();
	// A real process whose argv[0] basename is `pi` — the cmdline contract
	// of a delegate child without booting a full pi session.
	const fakePi = path.join(dir, "pi");
	fs.writeFileSync(fakePi, "#!/bin/sh\nsleep 30\n");
	fs.chmodSync(fakePi, 0o755);
	const child = childProcess.spawn(fakePi, [], { stdio: "ignore" });
	await new Promise((r) => setTimeout(r, 200));
	updateRunMetadata(dir, opened.metadata.runId, (m) => ({ ...m, state: "running", pid: child.pid }));
	const marked = markOrphanedRuns(dir);
	assert.ok(!marked.includes(opened.metadata.runId), "live pi owner must be skipped");
	assert.equal(readRunMetadata(dir, opened.metadata.runId)?.state, "running");
	try {
		child.kill("SIGKILL");
	} catch {
		// ignore
	}
	await new Promise((r) => setTimeout(r, 300));
	const marked2 = markOrphanedRuns(dir);
	assert.ok(marked2.includes(opened.metadata.runId), "dead pid must be marked");
	assert.equal(readRunMetadata(dir, opened.metadata.runId)?.state, "crashed");
});

test("store: P1 — alive non-pi pid (recycled) is marked with a note", async () => {
	const dir = tmpDir("p1-recycled");
	const opened = openRun(dir, req());
	opened.stdout.end();
	opened.stderr.end();
	const child = childProcess.spawn("/bin/sleep", ["30"], { stdio: "ignore" });
	await new Promise((r) => setTimeout(r, 200));
	updateRunMetadata(dir, opened.metadata.runId, (m) => ({ ...m, state: "running", pid: child.pid }));
	const marked = markOrphanedRuns(dir);
	assert.ok(marked.includes(opened.metadata.runId), "recycled pid must be marked");
	const m = readRunMetadata(dir, opened.metadata.runId);
	assert.equal(m?.state, "crashed");
	assert.equal(m?.errorCode, "E_ORPHANED_RUN");
	assert.match(m?.errorMessage ?? "", /recycled pid/);
	try {
		child.kill("SIGKILL");
	} catch {
		// ignore
	}
});

test("store: P1 — markOrphanedRuns never touches terminal runs", () => {
	const dir = tmpDir("p1-terminal");
	const o = openRun(dir, req());
	o.stdout.end();
	o.stderr.end();
	updateRunMetadata(dir, o.metadata.runId, (m) => ({ ...m, state: "succeeded", finishedAt: new Date().toISOString() }));
	const marked = markOrphanedRuns(dir);
	assert.equal(marked.length, 0);
	assert.equal(readRunMetadata(dir, o.metadata.runId)?.state, "succeeded");
});

test("config: P2 — project overlay 2h hard + 44m user idle survive the cascade", () => {
	const dir = tmpDir("p2-cascade");
	const projectRoot = path.join(dir, "project");
	fs.mkdirSync(path.join(projectRoot, ".pi", "delegate"), { recursive: true });
	fs.writeFileSync(
		path.join(projectRoot, ".pi", "delegate", "config.json"),
		JSON.stringify({ hardTimeoutMs: 7_200_000 }),
	);
	fs.mkdirSync(path.join(dir, "delegate"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "delegate", "config.json"),
		JSON.stringify({ inactivityTimeoutMs: 2_640_000, hardTimeoutMs: 3_600_000 }),
	);
	const result = loadConfigCascade(dir, projectRoot);
	assert.equal(result.config.hardTimeoutMs, 7_200_000);
	assert.equal(result.config.inactivityTimeoutMs, 2_640_000, "user idle value preserved");
	assert.ok(result.projectOverrides.includes("hardTimeoutMs"));
	const t = resolveRunTimeouts(result.config);
	assert.equal(t.hardMs, 7_200_000);
	assert.equal(t.inactivityMs, 2_640_000, "44m < 2h/2 → no cap");
	const capped = resolveRunTimeouts({ ...result.config, inactivityTimeoutMs: 999_000_000 });
	assert.equal(capped.inactivityMs, 3_600_000, "inactivity capped at half of hard");
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

// ── Timeout: duration, flags, cascade ─────────────────────────────────────

test("timeout: parseDuration handles units and bare ms", async () => {
	const { parseDuration } = await import("../config.ts");
	assert.equal(parseDuration("90s"), 90_000);
	assert.equal(parseDuration("10m"), 600_000);
	assert.equal(parseDuration("2h"), 7_200_000);
	assert.equal(parseDuration("1d"), 86_400_000);
	assert.equal(parseDuration("12345"), 12_345);
	assert.equal(parseDuration(""), undefined);
	assert.throws(() => parseDuration("soon"));
});

test("timeout: extractFlags pulls --timeout from any position", async () => {
	const { extractFlags } = await import("../commands.ts");
	const a = extractFlags("research a topic --timeout 30m");
	assert.equal(a.task, "research a topic");
	assert.equal(a.timeoutMs, 1_800_000);
	const b = extractFlags("--timeout 1h do the thing");
	assert.equal(b.task, "do the thing");
	assert.equal(b.timeoutMs, 3_600_000);
	const c = extractFlags("no flags here");
	assert.equal(c.task, "no flags here");
	assert.equal(c.timeoutMs, undefined);
	const d = extractFlags("task --timeout");
	assert.ok(d.error?.includes("--timeout needs a value"));
	const e = extractFlags("task --timeout soon");
	assert.ok(e.error?.includes("invalid duration"));
});

test("timeout: command grammar wires --timeout into run intents", async () => {
	const { parseDelegateCommand } = await import("../commands.ts");
	const a = parseDelegateCommand("run general fix the bug --timeout 2h");
	assert.equal(a.kind, "run");
	if (a.kind === "run") {
		assert.equal(a.role, "general");
		assert.equal(a.task, "fix the bug");
		assert.equal(a.timeoutMs, 7_200_000);
	}
	const b = parseDelegateCommand("research compare approaches --timeout 45m");
	if (b.kind === "run") {
		assert.equal(b.role, "research");
		assert.equal(b.timeoutMs, 2_700_000);
	}
	const c = parseDelegateCommand("plain task --timeout 5m");
	if (c.kind === "run") {
		assert.equal(c.role, "general");
		assert.equal(c.task, "plain task");
		assert.equal(c.timeoutMs, 300_000);
	}
});

test("timeout: project config overlays user config field-by-field", async () => {
	const { loadConfigCascade, projectConfigPath } = await import("../config.ts");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-tmo-"));
	const agentDir = path.join(dir, "agent");
	const proj = path.join(dir, "proj");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.dirname(projectConfigPath(proj)), { recursive: true });
	// user config
	fs.mkdirSync(path.join(agentDir, "delegate"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "delegate", "config.json"), JSON.stringify({ schemaVersion: 1, hardTimeoutMs: 600_000, inactivityTimeoutMs: 120_000 }));
	// project overlay: only hardTimeoutMs
	fs.writeFileSync(projectConfigPath(proj), JSON.stringify({ hardTimeoutMs: 7_200_000 }));
	const res = loadConfigCascade(agentDir, proj);
	assert.equal(res.config.hardTimeoutMs, 7_200_000, "project overrides user");
	assert.equal(res.config.inactivityTimeoutMs, 120_000, "unlisted keys keep user value");
	assert.deepEqual(res.projectOverrides, ["hardTimeoutMs"]);
	assert.deepEqual(res.projectSetKeys, ["hardTimeoutMs"], "file truth: present keys are reported");
	// no project file → user config unchanged
	const res2 = loadConfigCascade(agentDir, path.join(dir, "no-proj"));
	assert.equal(res2.config.hardTimeoutMs, 600_000);
	assert.deepEqual(res2.projectOverrides, []);
	assert.deepEqual(res2.projectSetKeys, []);
	// corrupt project file → user wins, diagnosed
	fs.writeFileSync(projectConfigPath(proj), "{ not json");
	const res3 = loadConfigCascade(agentDir, proj);
	assert.equal(res3.config.hardTimeoutMs, 600_000);
	assert.ok(res3.projectCorrupt);
});

test("timeout: project values are clamped by the same bounds", async () => {
	const { loadConfigCascade, projectConfigPath } = await import("../config.ts");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-tmo-clamp-"));
	const agentDir = path.join(dir, "agent");
	const proj = path.join(dir, "proj");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.dirname(projectConfigPath(proj)), { recursive: true });
	fs.writeFileSync(projectConfigPath(proj), JSON.stringify({ hardTimeoutMs: 999_999_999_999 }));
	const res = loadConfigCascade(agentDir, proj);
	assert.equal(res.config.hardTimeoutMs, 604_800_000, "clamped to max week");
	assert.deepEqual(res.projectSetKeys, ["hardTimeoutMs"], "clamped key still counts as set");
});

test("overlay: projectSetKeys reports every known key in the file, equal to base or not", async () => {
	const { applyProjectOverlay, DEFAULT_DELEGATE_CONFIG, projectConfigPath } = await import("../config.ts");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-setkeys-"));
	const proj = path.join(dir, "proj");
	const base = { ...DEFAULT_DELEGATE_CONFIG };
	// missing file → neither array populated
	assert.deepEqual(applyProjectOverlay(base, proj).projectSetKeys, []);
	assert.deepEqual(applyProjectOverlay(base, proj).projectOverrides, []);
	// hardTimeoutMs EQUAL to base (the display-lie case) + one differing key
	// + schemaVersion + an unknown key, which are never reported as set
	fs.mkdirSync(path.dirname(projectConfigPath(proj)), { recursive: true });
	fs.writeFileSync(projectConfigPath(proj), JSON.stringify({ schemaVersion: 1, hardTimeoutMs: base.hardTimeoutMs, queueLimit: 9, notAKey: 1 }));
	const r1 = applyProjectOverlay(base, proj);
	assert.equal(r1.hardTimeoutMs, base.hardTimeoutMs, "equal value changes nothing effective");
	assert.equal(r1.queueLimit, 9);
	assert.deepEqual(r1.projectOverrides, ["queueLimit"], "overrides stay equality-based");
	assert.deepEqual(r1.projectSetKeys, ["hardTimeoutMs", "queueLimit"], "set keys are file presence");
	// corrupt file → nothing contributed, nothing reported as set
	fs.writeFileSync(projectConfigPath(proj), "{ broken");
	const r2 = applyProjectOverlay(base, proj);
	assert.ok(r2.projectCorrupt);
	assert.deepEqual(r2.projectSetKeys, []);
	assert.deepEqual(r2.projectOverrides, []);
});

// ── Timeout display + project saves ───────────────────────────────────────

test("timeout: formatDuration renders human units", async () => {
	const { formatDuration } = await import("../config.ts");
	assert.equal(formatDuration(500), "500ms");
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(90_000), "1m 30s");
	assert.equal(formatDuration(1_800_000), "30m");
	assert.equal(formatDuration(5_400_000), "1h 30m");
	assert.equal(formatDuration(93_600_000), "1d 2h");
});

test("timeout: resolveRunTimeouts caps inactivity at half of hard", async () => {
	const { resolveRunTimeouts, DEFAULT_DELEGATE_CONFIG } = await import("../config.ts");
	const base = { ...DEFAULT_DELEGATE_CONFIG, hardTimeoutMs: 30 * 60_000, inactivityTimeoutMs: 5 * 60_000 };
	// no override: unchanged (5m < 15m cap); stuck-tool defaults to hard (R1)
	assert.deepEqual(resolveRunTimeouts(base), { hardMs: 30 * 60_000, inactivityMs: 5 * 60_000, stuckToolMs: 30 * 60_000, hardSource: "config" });
	// per-invocation 8m: inactivity capped to 4m
	assert.deepEqual(resolveRunTimeouts(base, 8 * 60_000), { hardMs: 8 * 60_000, inactivityMs: 4 * 60_000, stuckToolMs: 8 * 60_000, hardSource: "per-run" });
	// per-invocation 2h: inactivity stays 5m
	assert.deepEqual(resolveRunTimeouts(base, 2 * 3_600_000), { hardMs: 2 * 3_600_000, inactivityMs: 5 * 60_000, stuckToolMs: 2 * 3_600_000, hardSource: "per-run" });
	// per-invocation clamped to bounds
	assert.equal(resolveRunTimeouts(base, 999).hardMs, 1_000, "min clamp");
	assert.equal(resolveRunTimeouts(base, 10 ** 15).hardMs, 604_800_000, "max clamp");
});

test("timeout: saveProjectConfig creates, merges, recovers from corruption", async () => {
	const { saveProjectConfig, projectConfigPath } = await import("../config.ts");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-proj-save-"));
	const pPath = projectConfigPath(dir);
	// create
	saveProjectConfig(dir, { hardTimeoutMs: 7_200_000 });
	assert.equal(JSON.parse(fs.readFileSync(pPath, "utf8")).hardTimeoutMs, 7_200_000);
	// merge preserves existing keys, ignores unknown
	saveProjectConfig(dir, { inactivityTimeoutMs: 120_000 } as never);
	const merged = JSON.parse(fs.readFileSync(pPath, "utf8"));
	assert.equal(merged.hardTimeoutMs, 7_200_000);
	assert.equal(merged.inactivityTimeoutMs, 120_000);
	assert.equal(merged.notAKey, undefined);
	// corruption preserved as evidence, replaced
	fs.writeFileSync(pPath, "{ broken");
	saveProjectConfig(dir, { hardTimeoutMs: 1_800_000 });
	assert.equal(JSON.parse(fs.readFileSync(pPath, "utf8")).hardTimeoutMs, 1_800_000);
	assert.ok(fs.readdirSync(path.dirname(pPath)).some((f) => f.includes(".corrupt-")));
});

test("timeout: clampConfigField rejects unknown keys, clamps bounds", async () => {
	const { clampConfigField } = await import("../config.ts");
	assert.equal(clampConfigField("hardTimeoutMs", 7200_000), 7_200_000);
	assert.equal(clampConfigField("hardTimeoutMs", 999_999_999), 604_800_000);
	assert.equal(clampConfigField("hardTimeoutMs", 10), 1_000);
	assert.equal(clampConfigField("defaultRole", 5), null);
	assert.equal(clampConfigField("nope", 5), null);
});

// ── R7: version provenance ───────────────────────────────────────────────

test("R7: delegateVersion matches package.json", async () => {
	const { delegateVersion } = await import("../version.ts");
	const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(delegateVersion(), pkg.version);
	assert.notEqual(delegateVersion(), "unknown");
});

test("classify: tool_end failure flag is authoritative, never content-derived", () => {
	// Pi emits `isError` at the TOP level of tool_execution_end; reading only
	// `result.isError` silently marked every real tool failure as a success.
	// Content is NEVER a failure signal (see transcript-feed.ts toolFailed).
	const mk = (parsed: unknown) => ({ raw: Buffer.from(""), parsed, malformed: false }) as never;
	const flagged = classifyRpcRecord(
		mk({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Command exited with code 1" }] } }),
	) as { result?: { isError?: boolean } };
	assert.equal(flagged.result?.isError, true, "top-level isError survives classification");
	const nested = classifyRpcRecord(mk({ type: "tool_execution_end", result: { isError: true, content: [] } })) as { result?: { isError?: boolean } };
	assert.equal(nested.result?.isError, true, "result.isError still honoured");
	const snake = classifyRpcRecord(mk({ type: "tool_execution_end", is_error: true, result: { content: [] } })) as { result?: { isError?: boolean } };
	assert.equal(snake.result?.isError, true, "snake_case is_error still honoured");
	const okButAlarming = classifyRpcRecord(
		mk({ type: "tool_execution_end", isError: false, result: { content: [{ type: "text", text: 'throw new Error("boom") — 0 errors' }] } }),
	) as { result?: { isError?: boolean } };
	assert.equal(okButAlarming.result?.isError, false, "content mentioning 'error' is not a failure");
});

// ── R22: execution mode classification (default: background) ────────────

test("R22 config: defaultExecution defaults to background, normalizes both words, ignores junk", () => {
	assert.equal(DEFAULT_DELEGATE_CONFIG.defaultExecution, "background");
	assert.equal(normalizeConfig({}).config.defaultExecution, "background");
	assert.equal(normalizeConfig({ defaultExecution: "foreground" }).config.defaultExecution, "foreground");
	assert.equal(normalizeConfig({ defaultExecution: "background" }).config.defaultExecution, "background");
	// invalid values keep the default (applyKnownField normalization)
	assert.equal(normalizeConfig({ defaultExecution: "fg" }).config.defaultExecution, "background");
	assert.equal(normalizeConfig({ defaultExecution: 42 }).config.defaultExecution, "background");
	assert.equal(normalizeConfig({ defaultExecution: null }).config.defaultExecution, "background");
});

test("R22 config: project overlay carries defaultExecution", async () => {
	const { loadConfigCascade, projectConfigPath } = await import("../config.ts");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-exec-"));
	const agentDir = path.join(dir, "agent");
	const proj = path.join(dir, "proj");
	fs.mkdirSync(path.join(agentDir, "delegate"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "delegate", "config.json"), JSON.stringify({ schemaVersion: 1, defaultExecution: "foreground" }));
	const res = loadConfigCascade(agentDir, path.join(dir, "no-proj"));
	assert.equal(res.config.defaultExecution, "foreground", "user-wide defaultExecution loads");
	fs.mkdirSync(path.dirname(projectConfigPath(proj)), { recursive: true });
	fs.writeFileSync(projectConfigPath(proj), JSON.stringify({ defaultExecution: "background" }));
	const res2 = loadConfigCascade(agentDir, proj);
	assert.equal(res2.config.defaultExecution, "background", "project overlay overrides");
	assert.ok(res2.projectOverrides.includes("defaultExecution"));
});

test("R22 app: defaultExecution() + patchDefaultExecution() persist through saveConfig", async () => {
	const { DelegateApplicationImpl } = await import("../application.ts");
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-exec-app-"));
	const app = new DelegateApplicationImpl({ agentDir: dir, config: { ...DEFAULT_DELEGATE_CONFIG } });
	assert.equal(app.defaultExecution(), "background");
	assert.equal(app.patchDefaultExecution("foreground"), null);
	assert.equal(app.defaultExecution(), "foreground");
	assert.ok(app.panelConfig().defaultExecution === "foreground");
	// persisted (loadConfig reads the same file saveConfig wrote)
	assert.equal(loadConfig(dir).config.defaultExecution, "foreground");
	// cycle back + reject junk
	assert.equal(app.patchDefaultExecution("background"), null);
	assert.equal(app.defaultExecution(), "background");
	assert.ok(app.patchDefaultExecution("bg" as never) !== null, "non-enum value rejected");
});

test("R22 grammar: --background / --foreground flags extract; both → invalid", async () => {
	const { parseDelegateCommand, extractFlags } = await import("../commands.ts");
	const a = extractFlags("do the thing --background");
	assert.equal(a.task, "do the thing");
	assert.equal(a.execution, "background");
	const b = extractFlags("--foreground fix the bug now");
	assert.equal(b.task, "fix the bug now");
	assert.equal(b.execution, "foreground");
	assert.equal(extractFlags("no flags").execution, undefined);
	const both = extractFlags("task --background --foreground");
	assert.ok(both.error?.includes("mutually exclusive"));
	// grammar: run intent carries execution; mutual exclusion → invalid
	const r1 = parseDelegateCommand("run general fix the bug --foreground");
	assert.equal(r1.kind, "run");
	if (r1.kind === "run") {
		assert.equal(r1.execution, "foreground");
		assert.equal(r1.task, "fix the bug");
	}
	const r2 = parseDelegateCommand("run general fix the bug --background");
	if (r2.kind === "run") assert.equal(r2.execution, "background");
	const r3 = parseDelegateCommand("plain task --foreground");
	if (r3.kind === "run") assert.equal(r3.execution, "foreground");
	assert.equal(parseDelegateCommand("run general x y z --background --foreground").kind, "invalid");
	// resume carries execution too
	const res1 = parseDelegateCommand("resume del_1 continue the work --foreground");
	if (res1.kind === "resume") {
		assert.equal(res1.execution, "foreground");
		assert.equal(res1.task, "continue the work");
	}
});

test("R22 grammar: /delegate fg mirrors bg (role optional, explicit foreground)", async () => {
	const { parseDelegateCommand } = await import("../commands.ts");
	const a = parseDelegateCommand("fg research read the spec now");
	assert.equal(a.kind, "fg");
	if (a.kind === "fg") {
		assert.equal(a.role, "research");
		assert.equal(a.task, "read the spec now");
	}
	const b = parseDelegateCommand("fg just do the thing");
	if (b.kind === "fg") {
		assert.equal(b.role, "general");
		assert.equal(b.task, "just do the thing");
	}
	assert.equal(parseDelegateCommand("fg").kind, "invalid");
	assert.equal(parseDelegateCommand("fg general").kind, "invalid");
	// bg still means explicit background
	const c = parseDelegateCommand("bg fix the flaky test");
	if (c.kind === "bg") assert.equal(c.task, "fix the flaky test");
});
