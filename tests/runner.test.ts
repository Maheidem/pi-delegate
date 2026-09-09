/**
 * delegate runner tests — real child processes (node -e) emulating Pi's
 * RPC event stream. Verifies §9 lifecycle: success, crash, malformed flood,
 * UI auto-cancel, idle timeout, idempotent cancellation, bounded handoff.
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DelegateRunner, describeToolAction, type RunnerConfig } from "../runner.ts";
import { openRun, runPaths } from "../run-store.ts";
import { resolveRole } from "../roles.ts";
import type { DelegateRequest } from "../types.ts";

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `delegate-run-${prefix}-`));
}

const FAST: RunnerConfig = {
	maxResultBytes: 64 * 1024,
	inactivityTimeoutMs: 3000,
	hardTimeoutMs: 20_000,
	killGraceMs: 700,
	updateThrottleMs: 50,
	handoffEnforceTimeoutMs: 2500,
};

function makeReq(task = "do the thing"): DelegateRequest {
	return { task, role: "general", source: "tool", cwd: process.cwd(), parentModel: "lm/studio", projectTrusted: true };
}

function fakeInvocation(script: string) {
	return () => ({ command: process.execPath, args: ["-e", script, "--"] });
}

function spawnRunner(agentDir: string, script: string, cfg: RunnerConfig = FAST, hooks = {}) {
	const opened = openRun(agentDir, makeReq());
	const runner = new DelegateRunner(
		opened,
		{
			agentDir,
			role: resolveRole("general", "general"),
			task: "do the thing",
			runId: opened.metadata.runId,
			parentModel: "lm/studio",
			cwd: process.cwd(),
			projectTrusted: true,
			registeredTools: ["read", "bash", "delegate"],
		},
		cfg,
		hooks,
		fakeInvocation(script),
	);
	return { runner, opened };
}

// Node -e fake child helpers ------------------------------------------------

const FAKE_OK = `
let buf = "";
let first = true;
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt" && (String(rec.id).endsWith(":handoff-required") || String(rec.id).endsWith(":handoff"))) {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "h1", toolName: "handoff", result: { content: [], details: { delegateHandoff: { outcome: "done", summary: "FINAL HANDOFF", changes: [], verification: [], remaining: [], risks: [] } } } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.exit(0);
    }
    if (rec.type === "prompt" && first) {
      first = false;
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FINAL HANDOFF" }], usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } }, stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
`;

test("runner: success captures transcript, bounded handoff, metadata", async () => {
	const dir = tmpDir("ok");
	const { runner, opened } = spawnRunner(dir, FAKE_OK);
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded");
	assert.match(outcome.handoff, /## Outcome \(done\)/);
	assert.match(outcome.handoff, /FINAL HANDOFF/);
	assert.equal(outcome.usage.output, 20);
	const lines = fs.readFileSync(opened.paths.transcriptPath, "utf8").trim().split("\n");
	assert.ok(lines.length >= 3);
	const meta = JSON.parse(fs.readFileSync(opened.paths.metadataPath, "utf8"));
	assert.equal(meta.state, "succeeded");
	assert.equal(meta.errorCode, undefined);
	assert.equal(meta.handoffData?.summary, "FINAL HANDOFF");
	assert.ok(meta.transcriptPath.includes(runner.runId));
});

const FAKE_UI_REQUEST = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "u1", method: "confirm" }) + "\\n");
    }
    if (rec.type === "prompt" && (String(rec.id).endsWith(":handoff-required") || String(rec.id).endsWith(":handoff"))) {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "h1", toolName: "handoff", result: { content: [], details: { delegateHandoff: { outcome: "done", summary: "UI OK", changes: [], verification: [], remaining: [], risks: [] } } } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.exit(0);
    }
    if (rec.type === "extension_ui_response") {
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }], usage: {}, stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
`;

test("runner: extension_ui_request auto-cancelled (no deadlock)", async () => {
	const dir = tmpDir("ui");
	const { runner } = spawnRunner(dir, FAKE_UI_REQUEST);
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded"); // would hang forever without auto-cancel
});

test("runner: crash before settle → crashed + stderr preserved", async () => {
	const dir = tmpDir("crash");
	const script = `
process.stdin.resume();
process.stderr.write("boom-stack-trace-here\\n");
process.exit(3);
`;
	const { runner } = spawnRunner(dir, script);
	const outcome = await runner.run();
	assert.equal(outcome.state, "crashed");
	assert.equal(outcome.exitCode, 3);
	assert.ok(openRunStderr(dir, runner.runId).includes("boom-stack-trace-here"));
});

function openRunStderr(dir: string, runId: string): string {
	const p = runPaths(dir, runId).stderrPath;
	return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

test("runner: malformed flood → E_RPC_PROTOCOL, records captured", async () => {
	const dir = tmpDir("malformed");
	const script = `
process.stdin.resume();
for (let i = 0; i < 40; i++) process.stdout.write("garbage-" + i + "\\n");
`;
	const { runner, opened } = spawnRunner(dir, script);
	const outcome = await runner.run();
	assert.equal(outcome.state, "failed");
	assert.equal(outcome.error?.code, "E_RPC_PROTOCOL");
	const captured = fs.readFileSync(opened.paths.transcriptPath, "utf8").trim().split("\n");
	assert.ok(captured.length >= 10, "malformed records must still be captured");
});

test("runner: idle timeout cancels to terminal receipt", async () => {
	const dir = tmpDir("idle");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    // then silence forever
    setInterval(() => {}, 10000);
  }
});
`;
	const { runner } = spawnRunner(dir, script, { ...FAST, inactivityTimeoutMs: 800 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "timed_out_idle");
	assert.ok(outcome.finishedAt);
	// P3: the terminal state carries a specific error payload — never
	// "unknown failure".
	assert.equal(outcome.error?.code, "E_TIMEOUT_IDLE");
	assert.match(outcome.error?.message ?? "", /no child activity for/);
	const meta = JSON.parse(fs.readFileSync(runPaths(dir, runner.runId).metadataPath, "utf8"));
	assert.equal(meta.errorCode, "E_TIMEOUT_IDLE");
	assert.match(meta.errorMessage ?? "", /no child activity for/);
});

test("runner: hard timeout wins over silence", async () => {
	const dir = tmpDir("hard");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    // periodic noise prevents idle timeout, but never settles
    setInterval(() => process.stdout.write(JSON.stringify({ type: "heartbeat" }) + "\\n"), 200);
  }
});
`;
	const { runner } = spawnRunner(dir, script, { ...FAST, hardTimeoutMs: 1500, inactivityTimeoutMs: 10_000 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "timed_out_hard");
	// P3: hard timeout carries its specific error payload.
	assert.equal(outcome.error?.code, "E_TIMEOUT_HARD");
	assert.match(outcome.error?.message ?? "", /hard timeout of/);
	const meta = JSON.parse(fs.readFileSync(runPaths(dir, runner.runId).metadataPath, "utf8"));
	assert.equal(meta.errorCode, "E_TIMEOUT_HARD");
	assert.match(meta.errorMessage ?? "", /hard timeout of/);
});

test("runner: cancel idempotent; abort → SIGTERM path; single finalize", async () => {
	const dir = tmpDir("cancel");
	const script = `
let buf = "";
process.on("SIGTERM", () => process.exit(143));
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    // never settles
  }
});
`;
	const { runner } = spawnRunner(dir, script);
	const runP = runner.run();
	await new Promise((r) => setTimeout(r, 300));
	runner.cancel("cancelled");
	runner.cancel("cancelled"); // second call must be idempotent
	runner.cancel("timed_out_hard"); // third too
	const outcome = await runP;
	assert.equal(outcome.state, "cancelled");
	const meta = JSON.parse(fs.readFileSync(runPaths(dir, runner.runId).metadataPath, "utf8"));
	assert.equal(meta.state, "cancelled");
	assert.ok(meta.finishedAt);
	// P3: user cancel carries its specific error payload.
	assert.equal(outcome.error?.code, "E_CANCELLED");
	assert.match(outcome.error?.message ?? "", /cancelled by user/);
	assert.equal(meta.errorCode, "E_CANCELLED");
	assert.match(meta.errorMessage ?? "", /cancelled by user/);
});

test("runner: P3 — settled with aborted stopReason → cancelled + abort message", async () => {
	const dir = tmpDir("p3-abort");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
`;
	const { runner } = spawnRunner(dir, script);
	const outcome = await runner.run();
	assert.equal(outcome.state, "cancelled");
	assert.equal(outcome.error?.code, "E_CANCELLED");
	assert.match(outcome.error?.message ?? "", /aborted/);
});

test("runner: stubborn child survives SIGTERM, gets SIGKILL", async () => {
	const dir = tmpDir("kill");
	const script = `
process.on("SIGTERM", () => { process.stderr.write("SIGTERM ignored\\n"); });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
  }
});
`;
	const { runner } = spawnRunner(dir, script);
	const runP = runner.run();
	await new Promise((r) => setTimeout(r, 300));
	runner.cancel("cancelled");
	const outcome = await runP;
	assert.equal(outcome.state, "cancelled");
	const pid = runner.childPid!;
	// give SIGKILL time to land
	await new Promise((r) => setTimeout(r, 1500));
	let alive = true;
	try {
		process.kill(pid, 0);
	} catch {
		alive = false;
	}
	assert.equal(alive, false, "child must be dead after killGrace");
});

test("runner: settled without final text → E_NO_HANDOFF", async () => {
	const dir = tmpDir("nohandoff");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
`;
	const { runner } = spawnRunner(dir, script);
	const outcome = await runner.run();
	assert.equal(outcome.state, "failed");
	assert.equal(outcome.error?.code, "E_NO_HANDOFF");
});

test("runner: model error stopReason → E_CHILD_MODEL", async () => {
	const dir = tmpDir("modelerr");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: {}, stopReason: "error" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
`;
	const { runner } = spawnRunner(dir, script);
	const outcome = await runner.run();
	assert.equal(outcome.state, "failed");
	assert.equal(outcome.error?.code, "E_CHILD_MODEL");
});

test("runner: oversized record → E_RPC_PROTOCOL", async () => {
	const dir = tmpDir("oversize");
	const script = `
process.stdin.resume();
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "x".repeat(10_000) } }) + "\\n");
`;
	const { runner } = spawnRunner(dir, script, { ...FAST, maxRecordBytes: 4096 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "failed");
	assert.equal(outcome.error?.code, "E_RPC_PROTOCOL");
});

// ── describeToolAction (display-safe last actions) ───────────────────────

test("runner: describeToolAction summarizes common tools", () => {
	assert.equal(describeToolAction("bash", { command: "npm test" }), "bash npm test");
	assert.equal(describeToolAction("edit", { path: "/a/b.ts" }), "edit /a/b.ts");
	assert.equal(describeToolAction("read", { path: "/x" }), "read /x");
	assert.equal(describeToolAction("grep", { pattern: "foo", path: "src" }), "grep foo src");
	assert.equal(describeToolAction("ls"), "ls");
	assert.equal(describeToolAction("mcp", {}), "mcp");
});

test("runner: describeToolAction truncates long args", () => {
	const out = describeToolAction("bash", { command: "x".repeat(200) });
	assert.ok(out.endsWith("…"));
	assert.ok(Array.from(out).length <= 100);
});

// ── R1: in-flight tool calls count as activity ───────────────────────────

test("R1: silent in-flight tool call survives the idle watchdog, completes", async () => {
	const dir = tmpDir("r1-open-tool");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt" && !(String(rec.id).endsWith(":handoff-required") || String(rec.id).endsWith(":handoff"))) {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 1.6" } }) + "\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "done" }] } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "SURVIVED" }], usage: {}, stopReason: "stop" } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        process.exit(0);
      }, 1600);
    }
  }
});
`;
	// The child exits after its free-text settle, so the enforcement prompt
	// EPIPEs and the free-text fallback finalizes immediately.
	const { runner } = spawnRunner(dir, script, { ...FAST, inactivityTimeoutMs: 500, stuckToolTimeoutMs: 4000 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded");
	assert.match(outcome.handoff, /SURVIVED/);
});

test("R1: stuck-tool budget still reaps a hung tool call", async () => {
	const dir = tmpDir("r1-stuck");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "hang" } }) + "\\n");
      setInterval(() => {}, 10000);
    }
  }
});
`;
	const { runner } = spawnRunner(dir, script, { ...FAST, inactivityTimeoutMs: 400, stuckToolTimeoutMs: 900, hardTimeoutMs: 60_000 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "timed_out_idle");
	assert.equal(outcome.error?.code, "E_TIMEOUT_IDLE");
	assert.match(outcome.error?.message ?? "", /stuck-tool budget/);
});

// ── R2: graceful timeout handoff (structured, via the handoff tool) ──────

test("R2: hard timeout mid-work captures a structured partial handoff", async () => {
	const dir = tmpDir("r2-handoff");
	const script = `
let buf = "";
let handoffDone = false;
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt" && !String(rec.id).endsWith(":handoff") && !String(rec.id).endsWith(":handoff-required")) {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "long-matrix" } }) + "\\n");
    }
    if (rec.type === "abort") {
      process.stdout.write(JSON.stringify({ type: "response", command: "abort", success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "Command aborted" }] } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
    if (rec.type === "prompt" && String(rec.id).endsWith(":handoff") && !handoffDone) {
      handoffDone = true;
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "h1", toolName: "handoff", result: { content: [], details: { delegateHandoff: { outcome: "partial", summary: "matrix run interrupted at 60%", changes: [{ path: "a.ts", action: "modified", note: "half migrated" }, { path: "b.ts", action: "created" }], verification: [{ command: "npm test", result: "fail", note: "2 failing" }], remaining: ["finish c.ts migration"], risks: [] } } } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.exit(0);
    }
  }
});
`;
	const { runner } = spawnRunner(dir, script, { ...FAST, hardTimeoutMs: 700, handoffGraceMs: 4000, inactivityTimeoutMs: 60_000 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "timed_out_hard");
	assert.equal(outcome.error?.code, "E_TIMEOUT_HARD");
	assert.match(outcome.partialHandoff ?? "", /## Outcome \(partial · captured at kill\)/);
	assert.match(outcome.partialHandoff ?? "", /a\.ts/);
	assert.match(outcome.partialHandoff ?? "", /✗ npm test/);
	assert.match(outcome.partialHandoff ?? "", /finish c\.ts migration/);
	const meta = JSON.parse(fs.readFileSync(runPaths(dir, runner.runId).metadataPath, "utf8"));
	assert.equal(meta.handoffData?.outcome, "partial");
	assert.equal(meta.errorCode, "E_TIMEOUT_HARD");
});

test("R2: child that never settles after abort still finalizes (no deadlock)", async () => {
	const dir = tmpDir("r2-nosettle");
	const script = `
process.on("SIGTERM", () => process.exit(143));
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt" && !String(rec.id).endsWith(":handoff") && !String(rec.id).endsWith(":handoff-required")) {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    }
    if (rec.type === "abort") {
      // swallow: tool hangs forever, child never settles
    }
  }
});
`;
	const { runner } = spawnRunner(dir, script, { ...FAST, hardTimeoutMs: 500, killGraceMs: 300, handoffGraceMs: 2000 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "timed_out_hard");
	assert.equal(outcome.exitCode, 143);
});

// ── R3: durable child session ────────────────────────────────────────────

test("R3: child args persist sessions (--session-dir) or re-enter (--session)", async () => {
	const { buildChildArgs } = await import("../runner.ts");
	const role = resolveRole("general", "general");
	const base = {
		agentDir: "/a", role, task: "t", runId: "del_20260903T000000Z_00000000",
		parentModel: "p/m", cwd: "/w", projectTrusted: true, registeredTools: [],
	};
	const fresh = buildChildArgs(base, role);
	assert.ok(fresh.args.includes("--session-dir"));
	const toolsArg = fresh.args[fresh.args.indexOf("--tools") + 1] ?? "";
	assert.ok(toolsArg.split(",").includes("handoff"), `handoff tool is in the child ceiling (${toolsArg})`);
	// R17 (async spec): ask_parent is FOREGROUND-FORBIDDEN — a foreground
	// child asking deadlocks the parent turn on itself by construction.
	assert.ok(!toolsArg.split(",").includes("ask_parent"), `no ask_parent in a foreground ceiling (${toolsArg})`);
	assert.ok(!fresh.env.PI_DELEGATE_ASK_DIR, "no ask env in a foreground spawn");
	const bg = buildChildArgs({ ...base, background: true, askDir: "/runs/answers/x", askTimeoutMs: 600_000, askMaxQuestions: 5 }, role);
	const bgTools = bg.args[bg.args.indexOf("--tools") + 1] ?? "";
	assert.ok(bgTools.split(",").includes("ask_parent"), `ask_parent in a background ceiling (${bgTools})`);
	assert.equal(bg.env.PI_DELEGATE_ASK_DIR, "/runs/answers/x");
	assert.equal(bg.env.PI_DELEGATE_BACKGROUND, "1");
	assert.ok(!fresh.args.includes("--no-session"));
	const resumed = buildChildArgs({ ...base, sessionPath: "/runs/x.session.jsonl" }, role);
	assert.equal(resumed.args[resumed.args.indexOf("--session") + 1], "/runs/x.session.jsonl");
});

test("R3: run records the child's durable session file in the receipt", async () => {
	const dir = tmpDir("r3-session");
	const sessionDir = path.join(dir, "sessions");
	fs.mkdirSync(sessionDir, { recursive: true });
	const opened = openRun(dir, makeReq());
	const sessionFile = path.join(sessionDir, "child.session.jsonl");
	const runner = new DelegateRunner(
		opened,
		{
			agentDir: dir,
			role: resolveRole("general", "general"),
			task: "t",
			runId: opened.metadata.runId,
			parentModel: "lm/studio",
			cwd: process.cwd(),
			projectTrusted: true,
			registeredTools: [],
			sessionDir,
		},
		FAST,
		{},
		fakeInvocation(`
let buf = "";
const fs = require("fs");
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (String(rec.id).endsWith(":handoff-required") || String(rec.id).endsWith(":handoff")) {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "h1", toolName: "handoff", result: { content: [], details: { delegateHandoff: { outcome: "done", summary: "OK", changes: [], verification: [], remaining: [], risks: [] } } } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.exit(0);
    }
    if (rec.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      fs.writeFileSync(${"SESSIONFILE_PLACEHOLDER"}, "{}\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "OK" }], usage: {}, stopReason: "stop" } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      }, 150);
    }
  }
});
`.replace("SESSIONFILE_PLACEHOLDER", JSON.stringify(sessionFile))),
	);
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded");
	const meta = JSON.parse(fs.readFileSync(opened.paths.metadataPath, "utf8"));
	assert.equal(meta.sessionPath, sessionFile);
});

// ── R4: precise provider-error diagnosis ─────────────────────────────────

test("R4: provider errorMessage is quoted verbatim as E_PROVIDER_ERROR", async () => {
	const dir = tmpDir("r4-provider");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: {}, stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.exit(0);
    }
  }
});
`;
	const { runner } = spawnRunner(dir, script);
	const outcome = await runner.run();
	assert.equal(outcome.state, "failed");
	assert.equal(outcome.error?.code, "E_PROVIDER_ERROR");
	assert.match(outcome.error?.message ?? "", /usage limit has been reached/);
	assert.ok(!/stderr tail/.test(outcome.error?.message ?? ""), "stderr tail must not be the cause");
});

test("R4: abort-artifact error message classified as killed-by-watchdog", async () => {
	const dir = tmpDir("r4-abort-artifact");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], usage: {}, stopReason: "error", errorMessage: "This operation was aborted" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.exit(0);
    }
  }
});
`;
	const { runner } = spawnRunner(dir, script);
	const outcome = await runner.run();
	assert.equal(outcome.state, "failed");
	assert.equal(outcome.error?.code, "E_CHILD_MODEL");
	assert.match(outcome.error?.message ?? "", /aborted mid-request/);
});

// ── R6: git worktree checkpoint ──────────────────────────────────────────

test("R6: receipt carries gitBase/gitStatus/gitDelta for a git cwd", async () => {
	const { execFileSync } = await import("node:child_process");
	const dir = tmpDir("r6-git");
	fs.writeFileSync(path.join(dir, "tracked.txt"), "one\n");
	execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir, stdio: "ignore" });
	fs.writeFileSync(path.join(dir, "dirty-before.txt"), "dirty\n");
	const opened = openRun(dir, { ...makeReq(), cwd: dir });
	const runner = new DelegateRunner(
		opened,
		{
			agentDir: dir,
			role: resolveRole("general", "general"),
			task: "t",
			runId: opened.metadata.runId,
			parentModel: "lm/studio",
			cwd: dir,
			projectTrusted: true,
			registeredTools: [],
		},
		FAST,
		{},
		fakeInvocation(FAKE_OK),
	);
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded");
	const meta = JSON.parse(fs.readFileSync(opened.paths.metadataPath, "utf8"));
	assert.match(meta.gitBase ?? "", /^[0-9a-f]{40}$/, "gitBase is the HEAD sha");
	assert.match(meta.gitStatus ?? "", /dirty-before\.txt/, "pre-run dirty state captured");
	assert.match(meta.gitDelta ?? "", /dirty-before\.txt/, "post-run delta vs HEAD captured");
});

// ── Structured-handoff protocol (mandatory, tool-enforced) ───────────────

test("runner: direct handoff-tool submission — deterministic render, no enforcement", async () => {
	const dir = tmpDir("ok-direct");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "h1", toolName: "handoff", result: { content: [], details: { delegateHandoff: { outcome: "done", summary: "DIRECT", changes: [{ path: "a.ts", action: "modified" }], verification: [{ command: "npm test", result: "pass" }], remaining: [], risks: [] } } } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: {}, stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      process.exit(0);
    }
  }
});
`;
	const { runner } = spawnRunner(dir, script);
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded");
	assert.match(outcome.handoff, /- modified a\.ts/);
	assert.match(outcome.handoff, /✓ npm test/);
	assert.equal(JSON.parse(fs.readFileSync(runPaths(dir, runner.runId).metadataPath, "utf8")).handoffData?.summary, "DIRECT");
});

test("runner: child never complies — free-text fallback after bounded retries (no hang)", async () => {
	const dir = tmpDir("ok-stubborn");
	const script = `
let buf = "";
let count = 0;
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") {
      count += 1;
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "JUST TEXT " + count }], usage: {}, stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
`;
	const started = Date.now();
	const { runner } = spawnRunner(dir, script, { ...FAST, hardTimeoutMs: 120_000 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded");
	assert.match(outcome.handoff, /JUST TEXT/, "free text accepted after enforcement retries");
	const meta = JSON.parse(fs.readFileSync(runPaths(dir, runner.runId).metadataPath, "utf8"));
	assert.ok((meta.errorMessage ?? "").includes("free-text handoff accepted"), "diagnostic note recorded");
	assert.ok(Date.now() - started < 30_000, "bounded: enforcement never waits for the hard cap");
});

test("runner: silent-after-settle child hits the enforcement deadline, not the hard cap", async () => {
	const dir = tmpDir("ok-silent-after-settle");
	const script = `
let buf = "";
let done = false;
process.stdin.on("data", (c) => {
  if (done) return;
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") {
      done = true;
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ONE SHOT" }], usage: {}, stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
`;
	const started = Date.now();
	const { runner } = spawnRunner(dir, script, { ...FAST, hardTimeoutMs: 120_000, inactivityTimeoutMs: 120_000, handoffEnforceTimeoutMs: 1500 });
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded");
	assert.match(outcome.handoff, /ONE SHOT/);
	const meta = JSON.parse(fs.readFileSync(runPaths(dir, runner.runId).metadataPath, "utf8"));
	assert.ok((meta.errorMessage ?? "").includes("free-text handoff accepted"), "fallback note");
	assert.ok(Date.now() - started < 15_000, "finalized by the enforcement deadline, not the hard cap");
});
