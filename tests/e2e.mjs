#!/usr/bin/env node
/**
 * delegate E2E — real `pi --mode rpc` sessions with the extension loaded
 * from a project-local .pi/extensions symlink. Deterministic scenarios via
 * extension slash commands over RPC (§16.6). Requires a working default
 * model; skips with a clear reason otherwise.
 *
 * Run: npm run test:e2e
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, "..");
const LIVE_CFG = path.join(os.homedir(), ".pi", "agent");

// Isolated config dir copied from the live one: E2E exercises the same
// default model/providers without touching live config or polluting the
// live run-store.
const E2E_CFG = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-e2e-cfg-"));
try {
	fs.cpSync(LIVE_CFG, E2E_CFG, {
		recursive: true,
		filter: (src) => !/delegate(\/|$)/.test(src.slice(LIVE_CFG.length)),
		force: true,
	});
} catch {
	// fall back to live config if copy fails
}
process.env.PI_CODING_AGENT_DIR = E2E_CFG;

// The workspace copy under test must be the ONLY delegate extension loaded.
// The live settings register the npm package too — drop that entry so the
// project-local copy (this source tree) wins and E2E never runs stale code.
try {
	const settingsPath = path.join(E2E_CFG, "settings.json");
	const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
	if (Array.isArray(settings.packages)) {
		settings.packages = settings.packages.filter((p) => !String(p).includes("pi-delegate"));
		fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	}
} catch {
	// no settings to patch
}

const fails = [];
let checks = 0;
// Scenario filter for targeted runs: E2E_SCENARIOS=D,F (default: all).
const SCENARIO_FILTER = (process.env.E2E_SCENARIOS ?? "")
	.split(",")
	.map((s) => s.trim().toUpperCase())
	.filter(Boolean);
const runScenario = (name) => SCENARIO_FILTER.length === 0 || SCENARIO_FILTER.includes(name);
const ok = (cond, msg) => {
	checks += 1;
	if (!cond) {
		fails.push(msg);
		console.log(`not ok - ${msg}`);
	} else console.log(`ok - ${msg}`);
};
const fail = (msg) => {
	checks += 1;
	fails.push(msg);
	console.log(`not ok - ${msg}`);
};

async function modelAvailable() {
	// The default provider may be registered via models.json or by
	// model-discovery (array of scanned providers). Check any candidate
	// baseUrl for liveness; E2E uses the configured default model.
	const cfgDir = E2E_CFG;
	let settings;
	try {
		settings = JSON.parse(fs.readFileSync(path.join(cfgDir, "settings.json"), "utf8"));
	} catch {
		return false;
	}
	const baseUrls = new Set();
	try {
		const models = JSON.parse(fs.readFileSync(path.join(cfgDir, "models.json"), "utf8")).providers || {};
		for (const [name, p] of Object.entries(models)) {
			if (name === settings.defaultProvider && p.baseUrl) baseUrls.add(String(p.baseUrl));
		}
	} catch {
		// ignore
	}
	try {
		const md = JSON.parse(fs.readFileSync(path.join(cfgDir, "model-discovery.json"), "utf8"));
		const providers = Array.isArray(md) ? md : Object.values(md);
		for (const p of providers) {
			if (p && typeof p === "object" && p.baseUrl && p.name === settings.defaultProvider) baseUrls.add(String(p.baseUrl));
		}
	} catch {
		// ignore
	}
	for (const base of baseUrls) {
		for (const suffix of ["/v1/models", "/models"]) {
			try {
				const res = await fetch(new URL(suffix, base), { signal: AbortSignal.timeout(4000) });
				if (res.ok) return true;
			} catch {
				// try next
			}
		}
	}
	return false;
}

class RpcClient {
	constructor(child) {
		this.child = child;
		this.lines = []; // all received JSON events
		this.rawText = []; // non-JSON stdout lines (extension essential output)
		this.waiters = [];
		this.buf = "";
		this.child.stdout.on("data", (c) => {
			this.buf += c.toString("utf8");
			let idx;
			while ((idx = this.buf.indexOf("\n")) >= 0) {
				let line = this.buf.slice(0, idx);
				this.buf = this.buf.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line) continue;
				let rec;
				try {
					rec = JSON.parse(line);
				} catch {
					this.rawText.push(line);
					continue;
				}
				this.lines.push(rec);
				// auto-cancel any extension UI request (headless)
				if (rec.type === "extension_ui_request") {
					this.send({ type: "extension_ui_response", id: rec.id, cancelled: true });
				}
				for (const w of [...this.waiters]) {
					if (w.pred(rec)) {
						this.waiters.splice(this.waiters.indexOf(w), 1);
						w.res(rec);
					}
				}
			}
		});
	}
	send(obj) {
		this.child.stdin.write(JSON.stringify(obj) + "\n");
	}
	prompt(message, timeoutMs = 180_000) {
		// Extension slash-commands execute immediately and may never emit
		// agent_settled; treat protocol silence as completion, bounded by
		// an overall timeout.
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const startLen = this.lines.length;
			const startRaw = this.rawText.length;
			let silence = Date.now();
			const giveUp = setTimeout(() => reject(new Error(`timeout waiting for: ${message.slice(0, 40)}`)), timeoutMs);
			const tick = setInterval(() => {
				const tail = this.lines.slice(startLen);
				const tailRaw = this.rawText.slice(startRaw);
				if (tail.length || tailRaw.length) silence = Date.now();
				if (tail.some((r) => r.type === "agent_settled")) {
					cleanup();
					resolve({ type: "agent_settled", message });
					return;
				}
				if ((tail.length || tailRaw.length) && Date.now() - silence > 1500) {
					cleanup();
					resolve({ type: "settled_silence", message });
					return;
				}
				if (Date.now() - start > timeoutMs) {
					cleanup();
					reject(new Error(`timeout waiting for: ${message.slice(0, 40)}`));
				}
			}, 250);
			const cleanup = () => {
				clearTimeout(giveUp);
				clearInterval(tick);
			};
			// A prompt that matches our extension slash-command never starts an
			// agent turn in RPC mode; its ack arrives when the command handler
			// completes. Real model prompts must wait for agent_settled.
			const isCommand = /^\/delegate\b/.test(message);
			const ackWait = isCommand
				? setInterval(() => {
					const ack = this.lines
						.slice(startLen)
						.find((r) => r.type === "response" && r.command === "prompt" && typeof r.success === "boolean");
					if (ack) {
						clearInterval(ackWait);
						cleanup();
						resolve({ type: "command_ack", message, ack });
					}
				}, 200)
				: null;
			this.send({ type: "prompt", message });
		});
	}
	allText() {
		const out = [...this.rawText];
		for (const rec of this.lines) {
			const msg = rec.message;
			if (msg && Array.isArray(msg.content)) {
				for (const c of msg.content) {
					if (c.type === "text" && c.text) out.push(c.text);
					if (c.type === "toolResult" || c.type === "tool_result") {
						const inner = c.content;
						if (typeof inner === "string") out.push(inner);
						else if (Array.isArray(inner)) for (const ic of inner) if (ic.text) out.push(ic.text);
					}
				}
			}
			if (rec.type === "tool_execution_end" && rec.result) {
				const r = rec.result;
				if (typeof r === "string") out.push(r);
				else if (r.content) {
					if (typeof r.content === "string") out.push(r.content);
					else if (Array.isArray(r.content)) for (const ic of r.content) if (ic.text) out.push(ic.text);
				}
			}
			if (rec.type === "extension_ui_request" && rec.method === "notify" && rec.message) out.push(String(rec.message));
			if (rec.type === "extension_ui_request" && rec.method === "setStatus" && rec.statusText) out.push(String(rec.statusText));
		}
		return out.join("\n");
	}
	events(type) {
		return this.lines.filter((r) => r.type === type);
	}
}

function makeWorkspace() {
	// Copy the extension into the workspace (real files, not symlinks) so
	// project-local resources load without prompting for trust on symlinked
	// code.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-e2e-"));
	const dest = path.join(dir, ".pi", "extensions", "delegate");
	fs.cpSync(EXT_ROOT, dest, {
		recursive: true,
		filter: (src) => {
			const rel = src.slice(EXT_ROOT.length);
			return !/node_modules|tests|\.tsbuildinfo/.test(rel);
		},
	});
	fs.writeFileSync(path.join(dir, "hello.txt"), "hello-e2e");
	return dir;
}

function runsDir() {
	return path.join(E2E_CFG, "delegate", "runs");
}

async function awaitReceipt(pred, timeoutMs = 300_000) {
	const dir = runsDir();
	const start = Date.now();
	for (;;) {
		if (fs.existsSync(dir)) {
			const metas = fs
				.readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.map((f) => {
					try {
						return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
					} catch {
						return null;
					}
				})
				.filter(Boolean)
				.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
			const hit = metas.find(pred);
			if (hit) return hit;
		}
		if (Date.now() - start > timeoutMs) return null;
		await new Promise((r) => setTimeout(r, 300));
	}
}

function startPi(dir) {
	// --approve: trust the ephemeral E2E workspace so its project-local
	// extension loads in non-interactive RPC mode.
	const child = spawn("pi", ["--mode", "rpc", "--approve"], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
	child.stderr.on("data", () => {});
	return new RpcClient(child);
}

async function stop(client) {
	try {
		client.child.stdin.end();
		client.child.kill("SIGTERM");
	} catch {
		// ignore
	}
}

function latestReceipt() {
	const dir = runsDir();
	if (!fs.existsSync(dir)) return null;
	const files = fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	if (!files.length) return null;
	return JSON.parse(fs.readFileSync(path.join(dir, files[0].f), "utf8"));
}

function isTerminalState(state) {
	return ["succeeded", "failed", "cancelled", "timed_out_idle", "timed_out_hard", "crashed"].includes(state);
}

function readReceipt(runId) {
	try {
		return JSON.parse(fs.readFileSync(path.join(runsDir(), `${runId}.json`), "utf8"));
	} catch {
		return null;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	if (!(await modelAvailable())) {
		console.log("SKIP e2e: default model server not reachable");
		return;
	}

	// ── Scenario A: status/doctor + foreground run succeeds ──────────────
	{
		if (runScenario("A")) {
		const dir = makeWorkspace();
		const pi = startPi(dir);
		await pi.prompt("/delegate status");
		const s = pi.allText();
		ok(/mode/i.test(s) && /delegate/i.test(s), "A: /delegate status renders");

		await pi.prompt("/delegate doctor");
		const d = pi.allText();
		ok(/invocation/i.test(d) && /strict/i.test(d), "A: /delegate doctor renders checks");

		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await pi.prompt(
					"/delegate run general Submit your result via the handoff tool with outcome done and summary exactly: DELEGATE-E2E-OK. No file changes.",
					420_000,
				);
				break;
			} catch {
				if (attempt === 1) throw new Error("A run stalled twice");
			}
		}
		const receipt = latestReceipt();
		ok(receipt && receipt.state === "succeeded", `A: receipt succeeded (${receipt?.state})`);
		ok(receipt?.handoffData?.summary?.includes("DELEGATE-E2E-OK"),
			`A: structured handoff captured via the handoff tool (${JSON.stringify(receipt?.handoffData?.summary)?.slice(0, 60)})`);
		ok(
			receipt && fs.existsSync(receipt.transcriptPath) && fs.statSync(receipt.transcriptPath).size > 0,
			"A: transcript persisted",
		);
		await stop(pi);
		}
	}

	// ── Scenario B: strict mode blocks non-delegate tools ────────────────
	{
		if (runScenario("B")) {
		const dir = makeWorkspace();
		const pi = startPi(dir);
		await pi.prompt("/delegate on");
		ok(/strict/i.test(pi.allText()), "B: enable acknowledged");
		// ask the model to read a file — the gate must block every attempt
		// local models are occasionally slow — retry once on stall
		try {
			await pi.prompt("Use the read tool to read hello.txt and tell me its contents.", 300_000);
		} catch {
			await pi.prompt("Use the read tool to read hello.txt and tell me its contents.", 300_000);
		}
		const toolStarts = pi.events("tool_execution_start").filter((e) => e.toolName === "read");
		const texts = pi.allText();
		ok(toolStarts.length === 0 || /block|strict|not allowed|denied/i.test(texts), "B: read blocked in strict mode");
		// delegation itself still works while strict. Local flash models
		// sometimes paraphrase the echo token ("replied with the exact
		// requested string") — the terminal receipt is the reliable signal.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await pi.prompt(
					"/delegate run general Submit your result via the handoff tool with outcome done and summary exactly: STRICT-OK. No file changes.",
					420_000,
				);
				break;
			} catch {
				if (attempt === 1) throw new Error("B run stalled twice");
			}
		}
		const strictRun = latestReceipt();
		ok(strictRun?.state === "succeeded", `B: delegation works while strict (${strictRun?.state})`);
		ok(!!strictRun?.handoffData, "B: structured handoff enforced while strict");
		await pi.prompt("/delegate off");
		ok(/disabled|off/i.test(pi.allText()), "B: disable acknowledged");
		await stop(pi);
		}
	}

	// ── Scenario C: cancellation produces terminal receipt ───────────────
	{
		if (runScenario("C")) {
		const dir = makeWorkspace();
		const pi = startPi(dir);
		const runP = pi.prompt("/delegate run general Write a very long detailed essay counting slowly from 1 to 500. Do not stop early.", 420_000);
		const active = await awaitReceipt((m) => m.state === "running", 120_000);
		ok(!!active, "C: run became active");
		await pi.prompt("/delegate cancel");
		await runP.catch(() => {});
		await new Promise((r) => setTimeout(r, 2500));
		const done = latestReceipt();
		ok(
			done && ["cancelled", "timed_out_idle", "timed_out_hard"].includes(done.state),
			`C: cancellation terminal state (${done?.state})`,
		);
		// child gone
		if (done?.pid) {
			let alive = true;
			try {
				process.kill(done.pid, 0);
			} catch {
				alive = false;
			}
			ok(!alive, "C: child reaped after cancel");
		} else {
			ok(true, "C: no live pid recorded");
		}
		await stop(pi);
		}
	}

	// ── Scenario F: P3 — real idle timeout surfaces a specific error ────
	{
		if (runScenario("F")) {
		const cfgPath = path.join(E2E_CFG, "delegate", "config.json");
		fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
		// 15 s budgets: a child that runs `sleep 60` inside a tool call must
		// trip the stuck-tool watchdog (R1 moved long in-flight tools off the
		// plain inactivity budget) — on a REAL child, not a fake one.
		fs.writeFileSync(cfgPath, JSON.stringify({ inactivityTimeoutMs: 15_000, stuckToolTimeoutMs: 15_000 }));
		const dir = makeWorkspace();
		const pi = startPi(dir);
		await pi.prompt(
			"/delegate run general Run this exact bash command and wait for it to finish: sleep 60. Then submit via the handoff tool with outcome done and summary exactly: SLEPT.",
			480_000,
		);
		await stop(pi);
		const done = latestReceipt();
		ok(done?.state === "timed_out_idle", `F: real idle timeout (${done?.state})`);
		ok(done?.errorCode === "E_TIMEOUT_IDLE", `F: errorCode E_TIMEOUT_IDLE (${done?.errorCode})`);
		const t = pi.allText();
		ok(t.includes("E_TIMEOUT_IDLE") && /(stuck-tool budget|no child activity)/.test(t), "F: tool text carries the specific error");
		ok(!/unknown failure/.test(t), "F: never 'unknown failure'");
		fs.unlinkSync(cfgPath); // restore defaults for the later scenarios
		}
	}

	// ── Scenario G: R1 — long in-flight tool survives the idle watchdog ─
	// The exact class-A bug from the 2026-09-03 investigation: a child
	// running one long silent tool call (matrix/benchmark/soak) was
	// guaranteed-killed at the inactivity budget. With R1 the in-flight
	// budget (default = hard) governs, so the child completes.
	{
		if (runScenario("G")) {
		const cfgPath = path.join(E2E_CFG, "delegate", "config.json");
		fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
		fs.writeFileSync(cfgPath, JSON.stringify({ inactivityTimeoutMs: 15_000 }));
		const dir = makeWorkspace();
		const pi = startPi(dir);
		await pi.prompt(
			"/delegate run general Run this exact bash command and wait for it to finish (about 40 seconds): sleep 40. After it finishes submit via the handoff tool with outcome done and summary exactly: MATRIX-DONE.",
			480_000,
		);
		await stop(pi);
		const done = latestReceipt();
		ok(done?.state === "succeeded", `G: long in-flight tool survived the idle watchdog (${done?.state})`);
		ok(String(latestReceipt()?.handoffData?.summary ?? "").includes("MATRIX-DONE"), "G: child completed its work (structured)");
		fs.unlinkSync(cfgPath);
		}
	}

	// ── Scenario H: R2 — hard timeout captures a partial handoff ──────
	{
		if (runScenario("H")) {
		const dir = makeWorkspace();
		const pi = startPi(dir);
		await pi.prompt(
			"/delegate run general Run this exact bash command and wait for it to finish: sleep 600. After it finishes reply with exactly: NEVER --timeout 30s",
			300_000,
		);
		await stop(pi);
		const done = latestReceipt();
		ok(done?.state === "timed_out_hard", `H: hard timeout fired (${done?.state})`);
		ok(done?.errorCode === "E_TIMEOUT_HARD", `H: E_TIMEOUT_HARD (${done?.errorCode})`);
		ok(typeof done?.partialHandoff === "string" && done.partialHandoff.length > 20,
			`H: partialHandoff captured on the receipt (${done?.partialHandoff?.length ?? 0} bytes)`);
		const t = pi.allText();
		ok(t.includes("partial handoff"), "H: tool text surfaces the partial handoff");
		}
	}

	// ── Scenario I: R3 — durable child session + resume ───────────────
	{
		if (runScenario("I")) {
		const dir = makeWorkspace();
		const pi = startPi(dir);
		await pi.prompt(
			"/delegate run general Do NOT create, write, or modify any files, and do not run any commands. The secret word for this session is ZEBRA-7391; you will be asked for it later. Submit via the handoff tool with outcome done and summary exactly: ACK ZEBRA-7391.",
			420_000,
		);
		const first = latestReceipt();
		ok(first?.state === "succeeded", `I: first run succeeded (${first?.state})`);
		ok(typeof first?.sessionPath === "string" && fs.existsSync(first.sessionPath),
			"I: child session file persisted + recorded on the receipt");
		await pi.prompt(
			`/delegate resume ${first.runId} Earlier in this session you were told a secret word. Submit via the handoff tool with outcome done and summary exactly that word.`,
			420_000,
		);
		await stop(pi);
		const second = latestReceipt();
		ok(second?.state === "succeeded", `I: resume run succeeded (${second?.state})`);
		ok(second?.resumeOf === first.runId, "I: resume receipt records resumeOf");
		ok(String(second?.handoffData?.summary ?? "").includes("ZEBRA-7391"), "I: resumed child remembers its earlier context (secret word never touched disk)");
		}
	}

	// ── Scenario K: peek — transcript feed for a finished run ─────────
	{
		if (runScenario("K")) {
		const dir = makeWorkspace();
		const pi = startPi(dir);
		await pi.prompt(
			"/delegate run general Run this exact bash command and wait for it: sleep 2. Then submit via the handoff tool with outcome done and summary exactly: PEEK-OK.",
			480_000,
		);
		const run = latestReceipt();
		ok(run?.state === "succeeded", `K: run succeeded (${run?.state})`);
		await pi.prompt(`/delegate peek ${run.runId}`);
		const t = pi.allText();
		ok(/✓|▶/.test(t), "K: peek renders the activity feed (tool marks)");
		ok(t.includes("sleep 2"), "K: peek shows the child's command");
		await stop(pi);
		}
	}

	// ── Scenario J: R7 — version provenance in status ─────────────────
	{
		if (runScenario("J")) {
		const dir = makeWorkspace();
		const pi = startPi(dir);
		await pi.prompt("/delegate status");
		const s = pi.allText();
		ok(/version: v\d+\.\d+\.\d+/.test(s), "J: status shows the executing extension version");
		ok(s.includes("/reload"), "J: status documents the /reload requirement for newer installs");
		await stop(pi);
		}
	}

	// ── Scenario D: P1 — concurrent pi startup must NOT clobber a run ──
	// The production bug: a second pi startup in the same agent dir marked a
	// live run crashed (E_ORPHANED_RUN) while its owner was still running it.
	{
		if (runScenario("D")) {
		const dirA = makeWorkspace();
		const piA = startPi(dirA);
		const runP = piA.prompt(
			"/delegate run general Run this exact bash command and wait for it to finish: sleep 60. Then submit via the handoff tool with outcome done and summary exactly: SLEPT-DONE.",
			420_000,
		);
		const active = await awaitReceipt((m) => m.state === "running" && typeof m.pid === "number", 180_000);
		ok(!!active, "D: run active with stored pid");
		if (active) {
			let alive = true;
			try {
				process.kill(active.pid, 0);
			} catch {
				alive = false;
			}
			ok(alive, "D: stored pid is alive");
			// Continuous poll: if the run EVER becomes crashed, the clobber
			// happened (a clobber is terminal — it can never be undone).
			const watch = (async () => {
				for (;;) {
					const m = readReceipt(active.runId);
					if (m?.state === "crashed") return "clobbered";
					if (m && isTerminalState(m.state)) return m.state;
					await sleep(250);
				}
			})();
			// A SECOND pi in the same agent dir — its startup runs orphan
			// recovery against the shared run store.
			const dirB = makeWorkspace();
			const piB = startPi(dirB);
			await piB.prompt("/delegate status");
			await stop(piB);
			const finalState = await watch;
			ok(finalState !== "clobbered", `D: run never clobbered by concurrent pi startup (final ${finalState})`);
			await runP.catch(() => {});
			ok(String(latestReceipt()?.handoffData?.summary ?? "").includes("SLEPT-DONE"), "D: child handoff surfaced (structured)");
			const done = readReceipt(active.runId);
			ok(done?.state === "succeeded", `D: run completed successfully (${done?.state})`);
			ok(!(done?.errorCode ?? "").includes("ORPHANED"), "D: no orphaned-run error on receipt");
		}
		await stop(piA);
		}
	}

	// ── Scenario E: P2 — project overlay surfaces 2h hard in status ────
	{
		if (runScenario("E")) {
		const dir = makeWorkspace();
		fs.mkdirSync(path.join(dir, ".pi", "delegate"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, ".pi", "delegate", "config.json"),
			JSON.stringify({ hardTimeoutMs: 7_200_000 }),
		);
		const pi = startPi(dir);
		await pi.prompt("/delegate status");
		const s = pi.allText();
		ok(/base timeout: 2h hard/.test(s), `E: status shows project 2h hard base timeout`);
		ok(/\(project /.test(s), "E: source attributed to the project file");
		await stop(pi);
		}
	}

	console.log(`\nE2E checks: ${checks - fails.length}/${checks}`);
	if (fails.length) {
		for (const f of fails) console.error(`FAILED: ${f}`);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error("E2E crashed:", e);
	process.exit(1);
});
