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

import { DelegateRunner, type RunnerConfig } from "../runner.ts";
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
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FINAL HANDOFF" }], usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } }, stopReason: "stop" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
`;

test("runner: success captures transcript, bounded handoff, metadata", async () => {
	const dir = tmpDir("ok");
	const { runner, opened } = spawnRunner(dir, FAKE_OK);
	const outcome = await runner.run();
	assert.equal(outcome.state, "succeeded");
	assert.equal(outcome.handoff, "FINAL HANDOFF");
	assert.equal(outcome.usage.output, 20);
	const lines = fs.readFileSync(opened.paths.transcriptPath, "utf8").trim().split("\n");
	assert.ok(lines.length >= 3);
	const meta = JSON.parse(fs.readFileSync(opened.paths.metadataPath, "utf8"));
	assert.equal(meta.state, "succeeded");
	assert.equal(meta.errorCode, undefined);
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
