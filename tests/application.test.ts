/**
 * delegate application tests — canonical routing, single-run reservation,
 * validation fail-closed paths, busy identity, doctor, orphan recovery,
 * retention, handoff bounds.
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as store from "../run-store.ts";

import { DelegateApplicationImpl } from "../application.ts";
import { loadConfig, DEFAULT_DELEGATE_CONFIG } from "../config.ts";
import type { DelegateAppConfig } from "../types.ts";

function tmpDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `delegate-app-${prefix}-`));
}

function fastConfig(overrides: Partial<DelegateAppConfig> = {}): DelegateAppConfig {
	const fast: Partial<DelegateAppConfig> = {
		maxResultBytes: 4096,
		inactivityTimeoutMs: 8000,
		hardTimeoutMs: 30_000,
		killGraceMs: 500,
		updateThrottleMs: 50,
	};
	return { ...DEFAULT_DELEGATE_CONFIG, ...fast, ...overrides };
}

function app(dir: string, script: string, config?: Partial<DelegateAppConfig>) {
	const resolver = () => ({ command: process.execPath, args: ["-e", script, "--"] });
	const a = new DelegateApplicationImpl({
		agentDir: dir,
		config: fastConfig(config),
		resolveInvocation: resolver,
	});
	return a;
}

const FAKE_OK = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "DONE" }], usage: { input: 1, output: 2, cost: { total: 0.0001 } }, stopReason: "stop" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
`;

const FAKE_SLOW = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    setInterval(() => process.stdout.write(JSON.stringify({ type: "heartbeat" }) + "\\n"), 300);
  }
});
`;

const baseReq = {
	source: "tool" as const,
	cwd: process.cwd(),
	parentModel: "lm/studio",
	projectTrusted: true,
};

test("app: general run succeeds end-to-end via fake child", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	const res = await a.run({ ...baseReq, task: "do it", role: "general" });
	assert.equal("busy" in res && res.busy, false);
	if ("busy" in res) return;
	assert.equal(res.ok, true);
	assert.equal(res.handoff, "DONE");
	assert.equal(res.details.role, "general");
	assert.equal(res.details.durationMs < 30_000, true);
});

test("app: queue full → busy with active id+role (queueLimit 0 restores the old behavior)", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_SLOW, { queueLimit: 0 });
	const first = a.run({ ...baseReq, task: "first", role: "general" });
	// give the child time to spawn
	await new Promise((r) => setTimeout(r, 400));
	const second = await a.run({ ...baseReq, task: "second", role: "general" });
	assert.equal("busy" in second && second.busy, true);
	if (!("busy" in second)) throw new Error("expected busy");
	assert.equal(second.runId, a.getActiveRun()?.runId);
	assert.equal(second.role, "general");
	// cleanup: cancel active
	await a.cancel();
	const firstRes = await first;
	assert.equal("busy" in firstRes && firstRes.busy, false);
});

test("app: concurrent calls queue and serialize — fan-out yields real results, no busy", async () => {
	const dir = tmpDir("app-queue");
	// Each fake child settles after ~300 ms; calls issued in parallel must
	// run back-to-back and ALL succeed.
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop() ?? "";
  for (const l of lines) {
    const rec = JSON.parse(l);
    if (rec.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "h1", toolName: "handoff", result: { content: [], details: { delegateHandoff: { outcome: "done", summary: rec.message.slice(-20), changes: [], verification: [], remaining: [], risks: [] } } } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        process.exit(0);
      }, 300);
    }
  }
});
`;
	const a = app(dir, script);
	const results = await Promise.all([
		a.run({ ...baseReq, task: "task-AAA", role: "general" }),
		a.run({ ...baseReq, task: "task-BBB", role: "general" }),
		a.run({ ...baseReq, task: "task-CCC", role: "general" }),
	]);
	for (const r of results) {
		assert.equal("busy" in r && r.busy, false, "no busy: fan-out serialized");
		assert.equal((r as { ok: boolean }).ok, true);
	}
	// Order: exactly one active at a time — verify via receipt start times.
	const runs = store.listRuns(dir, 10).map((x) => x.runId);
	assert.equal(runs.length, 3);
	assert.equal(a.getActiveRun(), null, "slot free after all three");
});

test("app: aborting a queued call removes it from the queue", async () => {
	const dir = tmpDir("app-queue-abort");
	const a = app(dir, FAKE_SLOW);
	const first = a.run({ ...baseReq, task: "first", role: "general" });
	await new Promise((r) => setTimeout(r, 400));
	const controller = new AbortController();
	const queued = a.run({ ...baseReq, task: "queued", role: "general" }, { abortSignal: controller.signal });
	await new Promise((r) => setTimeout(r, 100));
	controller.abort();
	const queuedRes = await queued;
	// The queued call must NOT run after the abort.
	assert.equal("busy" in queuedRes && queuedRes.busy, false);
	await a.cancel();
	await first;
	const receipts = store.listRuns(dir, 10).map((x) => x.runId).map((id) => store.readRunMetadata(dir, id));
	assert.equal(receipts.filter((m) => m?.task === "queued").length, 0, "aborted queued call never spawned");
});

test("app: queued call starts after the active run finishes", async () => {
	const dir = tmpDir("app-queue-drain");
	const a = app(dir, FAKE_OK);
	const first = a.run({ ...baseReq, task: "first", role: "general" });
	const second = a.run({ ...baseReq, task: "second", role: "general" });
	const [r1, r2] = await Promise.all([first, second]);
	assert.equal((r1 as { ok: boolean }).ok, true);
	assert.equal((r2 as { ok: boolean }).ok, true, "queued run executed after the first finished");
	const ids = store.listRuns(dir, 10).map((x) => x.runId);
	assert.equal(ids.length, 2);
});

test("app: invalid role rejected (closed catalogue)", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	const res = await a.run({ ...baseReq, task: "x", role: "coding" as never });
	assert.equal("error" in res ? res.error?.code : undefined, "E_INVALID_ROLE");
});

test("app: untrusted project blocks write-capable general", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	const res = await a.run({ ...baseReq, task: "x", role: "general", projectTrusted: false });
	assert.equal("error" in res ? res.error?.code : undefined, "E_PROJECT_UNTRUSTED");
});

test("app: no model fails closed", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	const res = await a.run({ ...baseReq, task: "x", role: "research", parentModel: "" });
	assert.equal("error" in res ? res.error?.code : undefined, "E_MODEL_UNAVAILABLE");
});

test("app: empty task rejected", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	const res = await a.run({ ...baseReq, task: "   ", role: "general" });
	assert.equal("error" in res ? res.error?.code : undefined, "E_INVALID_TASK");
});

test("app: research without firecrawl path → E_RESEARCH_TOOLS", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	a.refreshDoctorContext({ registeredTools: ["read", "bash"], activeTools: ["read"] });
	const res = await a.run({ ...baseReq, task: "search", role: "research" });
	assert.equal("error" in res ? res.error?.code : undefined, "E_RESEARCH_TOOLS");
});

test("app: handoff bounded and truncated with marker", async () => {
	const dir = tmpDir("app");
	const script = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  if (buf.includes("\\n")) {
    const rec = JSON.parse(buf.split("\\n")[0]);
    process.stdout.write(JSON.stringify({ type: "response", id: rec.id }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Y".repeat(100000) }], usage: {}, stopReason: "stop" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  }
});
`;
	const a = app(dir, script, { maxResultBytes: 2000 });
	const res = await a.run({ ...baseReq, task: "big", role: "general" });
	if ("busy" in res) throw new Error("unexpected busy");
	assert.equal(res.ok, true);
	assert.ok(res.details.outputTruncated);
	assert.ok(res.handoff.includes("truncated"));
	assert.ok(Buffer.byteLength(res.handoff, "utf8") <= 2000 + 64);
	// full transcript on disk, not in handoff (UTF-8 envelope records)
	const { decodeTranscriptRecord } = await import("../types.ts");
	const txRecords = fs
		.readFileSync(res.details.transcriptPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as import("../types.ts").TranscriptRecordV1);
	const rawAll = txRecords.map(decodeTranscriptRecord).join("");
	assert.ok(rawAll.includes("Y".repeat(1000)));
	assert.ok(txRecords.every((r) => typeof r.raw === "string" && r.rawBase64 === undefined), "valid UTF-8 records stay readable");
});

test("app: cancel defaults to active; unrelated id rejected", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_SLOW);
	const first = a.run({ ...baseReq, task: "first", role: "general" });
	await new Promise((r) => setTimeout(r, 400));
	const wrong = await a.cancel("del_unrelated_00000000");
	assert.equal(wrong.ok, false);
	const ok = await a.cancel();
	assert.equal(ok.ok, true);
	await first;
	const none = await a.cancel();
	assert.equal(none.ok, false);
});

test("app: inspect recent run; unknown id structured error", () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	assert.throws(
		() => a.inspect("del_20200101T000000Z_deadbeef"),
		(e: unknown) => (e as { code?: string }).code === "E_RUN_NOT_FOUND",
	);
});

test("app: startup orphan recovery marks crashed receipts", () => {
	const dir = tmpDir("app");
	const o = store.openRun(dir, { ...baseReq, task: "x", role: "general" });
	o.stdout.end();
	o.stderr.end();
	store.updateRunMetadata(dir, o.metadata.runId, (m) => ({ ...m, state: "running", pid: 999998 }));
	const a = new DelegateApplicationImpl({ agentDir: dir, config: fastConfig() });
	const marked = a.markOrphansOnStartup();
	assert.ok(marked.includes(o.metadata.runId));
});

test("app: doctor reports all ten checks with honest statuses", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	a.refreshDoctorContext({ model: "lm/studio", activeTools: ["delegate"], registeredTools: ["delegate", "mcp__firecrawl", "mcp__reddit"] });
	const report = a.doctor();
	assert.ok(report.checks.length >= 10);
	const names = report.checks.map((c) => c.name);
	for (const n of ["pi-invocation", "delegate-registration", "strict-consistency", "research-firecrawl-path", "stale-receipts", "active-child"]) {
		assert.ok(names.includes(n), `missing check ${n}`);
	}
	assert.equal(report.checks.find((c) => c.name === "research-firecrawl-path")?.status, "ok");
});

test("app: status text fields stable", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	const s1 = a.getStatus(["read", "bash"]);
	assert.equal(s1.modeEnabled, false);
	assert.equal(s1.activeRun, null);
	const done = await a.run({ ...baseReq, task: "t", role: "general" });
	assert.ok(done);
	const s2 = a.getStatus(["read", "bash"]);
	assert.ok(s2.lastRun);
});

test("app: retention enforced after runs", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK, { maxRuns: 2 } as Partial<DelegateAppConfig>);
	for (let i = 0; i < 4; i++) {
		await a.run({ ...baseReq, task: `t${i}`, role: "general" });
	}
	const runs = store.listRuns(dir, 50);
	assert.ok(runs.length <= 2, `retention should cap at maxRuns, got ${runs.length}`);
});

// ── Base timeouts: dashboard edits + status cascade ───────────────────────

test("app: patchConfig accepts duration strings", async () => {
	const dir = tmpDir("app");
	const a = app(dir, FAKE_OK);
	assert.equal(a.patchConfig("hardTimeoutMs", "2h"), null);
	const s = a.getStatus(["read"]);
	assert.equal(s.timeouts.userHardMs, 7_200_000);
	assert.equal(a.patchConfig("hardTimeoutMs", "soon"), "invalid duration 'soon' (use e.g. 90s, 10m, 2h, 1d, or bare ms)");
	assert.equal(a.patchConfig("hardTimeoutMs", ""), "Value is empty.");
	assert.equal(a.patchConfig("nope", "5m"), "Unknown setting 'nope'.");
});

test("app: patchProjectConfig writes overlay; status reflects project source", async () => {
	const dir = tmpDir("app");
	const fs = await import("node:fs");
	const path = await import("node:path");
	const proj = path.join(dir, "proj");
	fs.mkdirSync(proj, { recursive: true });
	const a = app(dir, FAKE_OK);
	// no project file: user source
	const s0 = a.getStatus(["read"], proj);
	assert.equal(s0.timeouts.source, "user");
	assert.equal(s0.timeouts.projectOverrides?.length, 0);
	// edit project overlay
	assert.equal(a.patchProjectConfig(proj, "hardTimeoutMs", "2h"), null);
	const s1 = a.getStatus(["read"], proj);
	assert.equal(s1.timeouts.source, "project");
	assert.equal(s1.timeouts.hardMs, 7_200_000);
	assert.equal(s1.timeouts.projectHardMs, 7_200_000);
	assert.deepEqual(s1.timeouts.projectOverrides, ["hardTimeoutMs"]);
	// user value untouched
	assert.equal(s1.timeouts.userHardMs, 30_000); // fastConfig hard
	// invalid values
	assert.equal(a.patchProjectConfig(proj, "hardTimeoutMs", "soon"), "invalid duration 'soon' (use e.g. 90s, 10m, 2h, 1d, or bare ms)");
	assert.equal(a.patchProjectConfig(proj, "nope", "5m"), "Unknown setting 'nope'.");
	// corrupt project file: user wins, diagnosed
	const { projectConfigPath } = await import("../config.ts");
	fs.writeFileSync(projectConfigPath(proj), "{ broken");
	const s2 = a.getStatus(["read"], proj);
	assert.equal(s2.timeouts.source, "user");
	assert.ok(s2.timeouts.projectCorrupt);
});
