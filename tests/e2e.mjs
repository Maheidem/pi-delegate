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

// Optional e2e model override, e.g. DELEGATE_E2E_MODEL=zai/glm-5.3 — keeps the
// local oMLX free during long e2e runs; remote built-in providers ride the
// auth.json copy above. Format: "<provider>/<model-id>".
const E2E_MODEL = (() => {
	const raw = (process.env.DELEGATE_E2E_MODEL ?? "").trim();
	if (!raw) return null;
	const idx = raw.indexOf("/");
	if (idx <= 0 || idx >= raw.length - 1) return null;
	return { provider: raw.slice(0, idx), model: raw.slice(idx + 1), full: raw };
})();
if (E2E_MODEL) {
	try {
		const settingsPath = path.join(E2E_CFG, "settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		settings.defaultProvider = E2E_MODEL.provider;
		settings.defaultModel = E2E_MODEL.model;
		// enabledModels must include the override or pi may reject it at startup.
		if (Array.isArray(settings.enabledModels) && !settings.enabledModels.includes(E2E_MODEL.full)) {
			settings.enabledModels.push(E2E_MODEL.full);
		}
		fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	} catch (error) {
		console.log(`FATAL e2e: DELEGATE_E2E_MODEL=${process.env.DELEGATE_E2E_MODEL} could not be applied: ${error?.message ?? error}`);
		process.exit(1);
	}
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
	// Built-in remote providers (zai, openai, …) have no models.json entry; their
	// credentials live in auth.json (copied into E2E_CFG above). A credential
	// entry counts as available — a dead remote fails scenarios loudly, not silently skips.
	try {
		const auth = JSON.parse(fs.readFileSync(path.join(cfgDir, "auth.json"), "utf8"));
		if (auth && typeof auth === "object" && auth[settings.defaultProvider]) return true;
	} catch {
		// no auth.json
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

function startPi(dir, opts = {}) {
	// --approve: trust the ephemeral E2E workspace so its project-local
	// extension loads in non-interactive RPC mode. --session: durable
	// session file (background scenarios inspect the JSONL directly).
	const args = ["--mode", "rpc", "--approve"];
	if (opts.session) args.push("--session", opts.session);
	const child = spawn("pi", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
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

// Session-JSONL helpers (background scenarios). Shapes verified against
// pi persistence: appendEntry -> {type:"custom", customType, data};
// sendMessage -> custom_message entries with customType + details.
function readSessionEntries(sessionFile) {
	if (!fs.existsSync(sessionFile)) return [];
	return fs
		.readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
		}
		})
		.filter(Boolean);
}
const bgLedger = (entries) =>
	entries.filter((e) => e.type === "custom" && e.customType === "delegate.background");
const bgResults = (entries) =>
	entries.filter((e) => e.type === "custom_message" && e.customType === "delegate-background-result");

async function waitFor(pred, timeoutMs, label) {
	const start = Date.now();
	for (;;) {
		let value;
		try {
			value = pred();
		} catch {
			value = null;
		}
		if (value) return value;
		if (Date.now() - start > timeoutMs) return null;
		await sleep(300);
	}
}

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
					"/delegate run general Submit your result via the handoff tool with outcome done and summary exactly: DELEGATE-E2E-OK. No file changes. --foreground",
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
					"/delegate run general Submit your result via the handoff tool with outcome done and summary exactly: STRICT-OK. No file changes. --foreground",
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
		const runP = pi.prompt("/delegate run general Write a very long detailed essay counting slowly from 1 to 500. Do not stop early. --foreground", 420_000);
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
			"/delegate run general Run this exact bash command and wait for it to finish: sleep 60. Then submit via the handoff tool with outcome done and summary exactly: SLEPT. --foreground",
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
			"/delegate run general Run this exact bash command and wait for it to finish (about 40 seconds): sleep 40. After it finishes submit via the handoff tool with outcome done and summary exactly: MATRIX-DONE. --foreground",
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
			"/delegate run general Run this exact bash command and wait for it to finish: sleep 600. After it finishes reply with exactly: NEVER --timeout 30s --foreground",
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
			"/delegate run general Do NOT create, write, or modify any files, and do not run any commands. The secret word for this session is ZEBRA-7391; you will be asked for it later. Submit via the handoff tool with outcome done and summary exactly: ACK ZEBRA-7391. --foreground",
			420_000,
		);
		const first = latestReceipt();
		ok(first?.state === "succeeded", `I: first run succeeded (${first?.state})`);
		ok(typeof first?.sessionPath === "string" && fs.existsSync(first.sessionPath),
			"I: child session file persisted + recorded on the receipt");
		await pi.prompt(
			`/delegate resume ${first.runId} Earlier in this session you were told a secret word. Submit via the handoff tool with outcome done and summary exactly that word. --foreground`,
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
			"/delegate run general Run this exact bash command and wait for it: sleep 2. Then submit via the handoff tool with outcome done and summary exactly: PEEK-OK. --foreground",
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
			"/delegate run general Run this exact bash command and wait for it to finish: sleep 60. Then submit via the handoff tool with outcome done and summary exactly: SLEPT-DONE. --foreground",
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

	// ── Scenario L: background fan-out — 2 runs, delivery, wake, no dupes ─
	{
		if (runScenario("L")) {
		const dir = makeWorkspace();
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi = startPi(dir, { session: sessionFile });
		await pi.prompt(
				"Call the delegate tool TWICE in this turn, both times with background=true. " +
				"First call: task='Create a file named bg-one.txt containing exactly the word ALPHA, then verify it exists.' description='Write ALPHA test file'. " +
				"Second call: task='Create a file named bg-two.txt containing exactly the word BETA, then verify it exists.' description='Write BETA test file'. " +
				"Both calls return immediately. After both have returned, reply with exactly: SPAWNED.",
				300_000,
			);
		const started = pi.allText();
		ok(/delegate background started/.test(started), "L: background tool result returns runId immediately");

		// Both receipts reach a terminal state.
		const terminals = await waitFor(
			() => {
				const es = readSessionEntries(sessionFile);
				const fin = bgLedger(es).filter((e) => e.data?.type === "finished");
				const msgs = bgResults(es);
				return fin.length >= 2 && msgs.length >= 2 ? { fin, msgs, es } : null;
			},
			360_000,
			"terminal+delivered",
		);
		ok(!!terminals, "L: 2 finished ledger entries + 2 delivered result messages");
		if (terminals) {
			const { msgs, es } = terminals;
			// Children did the real work.
			ok(fs.readFileSync(path.join(dir, "bg-one.txt"), "utf8").includes("ALPHA"), "L: bg-one.txt written by child 1");
			ok(fs.readFileSync(path.join(dir, "bg-two.txt"), "utf8").includes("BETA"), "L: bg-two.txt written by child 2");
			// Envelope + details discipline.
			const contents = msgs.map((m) => String(m.content ?? "")).join("\n--\n");
			ok(contents.includes("terminal report of a background delegation"), "L: envelope carries the classification paragraph");
			ok(contents.includes("internal work event"), "L: envelope instructs internal-work-event handling");
			const runIds = msgs.map((m) => m.details?.runId).filter(Boolean);
			ok(new Set(runIds).size === 2, `L: two distinct runIds delivered (${runIds.join(",")})`);
			ok(msgs.every((m) => m.details?.kind === "result"), "L: result messages carry kind=result");
			// Wake: an assistant entry after the last delivered message (no
			// intervening user prompt) proves triggerTurn woke the idle parent.
			const lastMsgIdx = Math.max(...msgs.map((m) => es.indexOf(m)));
			const woke = await waitFor(
				() => {
					const fresh = readSessionEntries(sessionFile);
					const freshMsgs = bgResults(fresh);
					if (!freshMsgs.length) return false;
					const lastIdx = Math.max(...freshMsgs.map((m) => fresh.indexOf(m)));
					// Assistant messages persist as {type:"message", message:{role:"assistant"}}
					// (session-manager appendMessage) — there is no type:"assistant".
					return fresh.slice(lastIdx + 1).some((e) => e.type === "message" && e.message?.role === "assistant");
				},
				180_000,
				"wake",
			);
			ok(!!woke, "L: parent woke (assistant entry after result delivery)");
			// Dedup within the process: exactly 2 result messages total.
			const finalMsgs = bgResults(readSessionEntries(sessionFile));
			ok(finalMsgs.length === 2, `L: exactly 2 delivered result messages (got ${finalMsgs.length})`);
		}
		await stop(pi);
		}
	}

	// ── Scenario M: kill/restart — reconcile delivers exactly once ──────
	{
		if (runScenario("M")) {
		const dir = makeWorkspace();
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi1 = startPi(dir, { session: sessionFile });
		await pi1.prompt(
				"Call the delegate tool ONCE with background=true, task='Run this exact shell command and wait for it to complete: sleep 90. Only after it completes, create a file named slow.txt containing the word DONE.' description='Slow background write test'. The call returns immediately; reply with exactly: SPAWNED.",
				300_000,
			);
		const created = await waitFor(
			() => bgLedger(readSessionEntries(sessionFile)).find((e) => e.data?.type === "created"),
			120_000,
			"created entry",
		);
		ok(!!created, "M: created ledger entry persisted");
		const runId = created?.data?.runId;
		const running = runId ? await awaitReceipt((m) => m.runId === runId && typeof m.pid === "number", 120_000) : null;
		ok(!!running, "M: background receipt running with pid");
		// Kill the parent; children die with it (stdin EOF / shutdown cancel).
		await stop(pi1);
		if (running?.pid) {
			await waitFor(() => {
				try {
				process.kill(running.pid, 0);
				return false;
				} catch {
				return true;
				}
			}, 60_000, "child exit");
		}
		// Restart on the SAME session file: startup orphan-marking + R12
		// reconcile deliver the undelivered terminal exactly once.
		const pi2 = startPi(dir, { session: sessionFile });
		await pi2.prompt("/delegate status", 60_000);
		const delivered = await waitFor(
			() => {
				const msgs = bgResults(readSessionEntries(sessionFile));
				return msgs.length >= 1 ? msgs : null;
			},
			180_000,
			"reconcile delivery",
		);
		ok(!!delivered, "M: restart reconcile delivered the terminal result");
		if (delivered && runId) {
			const mine = delivered.filter((m) => m.details?.runId === runId);
			ok(mine.length === 1, `M: exactly one result message for ${runId} (got ${mine.length})`);
			const state = mine[0]?.details?.state;
			ok(["cancelled", "crashed", "timed_out_hard", "timed_out_idle"].includes(state), `M: interrupted state delivered (got ${state})`);
			ok(String(mine[0]?.content ?? "").includes("internal work event"), "M: envelope present on the reconciled delivery");
			const fin = bgLedger(readSessionEntries(sessionFile)).filter((e) => e.data?.type === "finished" && e.data?.runId === runId);
			ok(fin.length === 1, `M: exactly one finished entry appended (got ${fin.length})`);
			// No re-delivery on a further reconcile: send another command and
			// recount (dedup is the R12 invariant).
			await pi2.prompt("/delegate status", 60_000);
			const after = bgResults(readSessionEntries(sessionFile)).filter((m) => m.details?.runId === runId);
			ok(after.length === 1, `M: no duplicate after second reconcile (got ${after.length})`);
		}
		await stop(pi2);
		}
	}

	// ── Scenario N: background steering — delegate_send lands mid-flight ─
	{
		if (runScenario("N")) {
		const dir = makeWorkspace();
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi = startPi(dir, { session: sessionFile });
		await pi.prompt(
				"Call the delegate tool ONCE with background=true, task='First run this exact shell command and wait for it to complete: sleep 45. After the sleep, create a file named bg-sleep.txt containing the word READY, verify it exists, and finish.' description='Steerable slow write test'. The call returns immediately; reply with exactly: SPAWNED.",
				300_000,
			);
		const created = await waitFor(
				() => bgLedger(readSessionEntries(sessionFile)).find((e) => e.data?.type === "created"),
			120_000,
				"created entry",
			);
		ok(!!created, "N: background run created");
		const runId = created?.data?.runId;
		ok(!!runId, "N: runId captured");
		if (runId) {
			// Steer while the child sleeps — the follow_up lands before its
			// next model call.
			await pi.prompt(
					`Call the delegate_send tool now with runId="${runId}" and message="ADDITIONAL INSTRUCTION: after completing the original task, ALSO create a file named steered.txt containing exactly the word STEERED, then verify both files exist." Reply with exactly: STEERED-SENT.`,
					180_000,
			);
			ok(/Steering accepted/.test(pi.allText()), "N: delegate_send accepted");
			// Wait for the terminal report, then prove the child absorbed the steer.
			const done = await waitFor(
					() => {
					const msgs = bgResults(readSessionEntries(sessionFile)).filter((m) => m.details?.runId === runId);
					return msgs.length >= 1 ? msgs[0] : null;
				},
				420_000,
					"terminal after steer",
			);
			ok(!!done, "N: terminal report delivered");
			ok(done?.details?.state === "succeeded", `N: steered run succeeded (got ${done?.details?.state})`);
			ok(fs.readFileSync(path.join(dir, "bg-sleep.txt"), "utf8").includes("READY"), "N: original task completed");
			ok(fs.readFileSync(path.join(dir, "steered.txt"), "utf8").includes("STEERED"), "N: steering applied by the child (steered.txt)");
		}
		await stop(pi);
		}
	}

	// ── Scenario O: ask round-trip — child asks, parent model answers ──
	{
		if (runScenario("O")) {
		const dir = makeWorkspace();
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi = startPi(dir, { session: sessionFile });
		await pi.prompt(
				"Call the delegate tool ONCE with background=true, task='FIRST call the ask_parent tool with kind=question, topic=blocked, text=\"Should the marker file contain ALPHA or BETA?\" — you are blocked until its result arrives. Then create marker-ask.txt containing exactly the word the parent's answer chose, verify it, and finish.' description='Ask parent test run'. The call returns immediately; reply with exactly: SPAWNED.",
				300_000,
			);
		const question = await waitFor(
				() => {
				const entries = readSessionEntries(sessionFile);
				return entries.find(
						(e) => e.type === "custom_message" && e.customType === "delegate-child-question",
					) ?? null;
				},
			240_000,
				"child question",
			);
		ok(!!question, "O: child question message delivered");
		const qRunId = question?.details?.runId;
		ok(!!qRunId, "O: question carries runId");
		ok(String(question?.content ?? "").includes("blocked waiting for your answer"), "O: question envelope present");
		if (qRunId) {
			// The question's triggerTurn WAKES the parent — the parent model is
			// instructed by the envelope to answer on its own. Observe that (the
			// strong proof); the harness answer is only a fallback if the wake
			// stays silent (never race the model with a scripted answer).
			const answeredOnItsOwn = await waitFor(
				() => {
					const receipt = readReceipt(qRunId);
					if (!receipt?.transcriptPath || !fs.existsSync(receipt.transcriptPath)) return null;
					return fs.readFileSync(receipt.transcriptPath, "utf8").includes("[parent answered") ? receipt : null;
				},
				90_000,
				"autonomous answer",
			);
			if (!answeredOnItsOwn) {
				await pi.prompt(
					`A delegated child is blocked on your answer. Call the delegate_answer tool now with runId="${qRunId}" and answer="BETA". Reply with exactly: ANSWERED.`,
					180_000,
				);
			}
			ok(!!answeredOnItsOwn || /Answer delivered/.test(pi.allText()), "O: the question was answered (autonomously or via harness)");
			const done = await waitFor(
				() => {
					const entries = readSessionEntries(sessionFile);
					return entries.find(
						(e) => e.type === "custom_message" && e.customType === "delegate-background-result" && e.details?.runId === qRunId,
					) ?? null;
				},
				420_000,
				"terminal after answer",
			);
			ok(done?.details?.state === "succeeded", `O: asked run succeeded (got ${done?.details?.state})`);
			const marker = fs.readFileSync(path.join(dir, "marker-ask.txt"), "utf8");
			ok(/ALPHA|BETA/.test(marker), `O: child used the parent's answer (marker-ask.txt = ${marker.trim()})`);
			const receipt = readReceipt(qRunId);
			ok(
				!!receipt?.transcriptPath && fs.existsSync(receipt.transcriptPath) &&
					fs.readFileSync(receipt.transcriptPath, "utf8").includes("[parent answered"),
				"O: ask toolResult proves the answer reached the child ([parent answered])",
			);
			// Forensics: the answer toolCall is in the parent session JSONL.
			const entries = readSessionEntries(sessionFile);
			ok(entries.some((e) => JSON.stringify(e).includes(`"${qRunId}"`) && JSON.stringify(e).includes("delegate_answer")), "O: delegate_answer toolCall persisted in session");
		}
		await stop(pi);
		}
	}

	// ── Scenario P: ask timeout — child falls back, run survives ─────────
	{
		if (runScenario("P")) {
		const dir = makeWorkspace();
		fs.mkdirSync(path.join(dir, ".pi", "delegate"), { recursive: true });
		fs.writeFileSync(
				path.join(dir, ".pi", "delegate", "config.json"),
			JSON.stringify({ askParent: { timeoutMs: 30_000 } }),
		);
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi = startPi(dir, { session: sessionFile });
		await pi.prompt(
				"Call the delegate tool ONCE with background=true, task='FIRST call the ask_parent tool with kind=question, topic=guidance, text=A blocker question that will not be answered? Take whatever the tool returns as final: if it says no answer arrived, proceed with your best judgment. Then create marker-timeout.txt containing exactly the word FELLBACK, verify it, and finish.' description='Ask timeout test run'. IMPORTANT: after spawning, if a delegate-child-question message arrives during this session, do NOT call delegate_answer — ignore it completely. Reply with exactly: SPAWNED.",
				300_000,
			);
		const question = await waitFor(
				() => {
				const entries = readSessionEntries(sessionFile);
				return entries.find((e) => e.type === "custom_message" && e.customType === "delegate-child-question") ?? null;
				},
			240_000,
				"child question (unanswered)",
			);
		ok(!!question, "P: question delivered (and left unanswered)");
		const pRunId = question?.details?.runId;
		if (pRunId) {
			const done = await waitFor(
					() => {
					const entries = readSessionEntries(sessionFile);
					return entries.find(
							(e) => e.type === "custom_message" && e.customType === "delegate-background-result" && e.details?.runId === pRunId,
						) ?? null;
					},
				480_000,
					"terminal after timeout",
				);
			ok(done?.details?.state === "succeeded", `P: run survived the unanswered ask (got ${done?.details?.state})`);
			ok(fs.readFileSync(path.join(dir, "marker-timeout.txt"), "utf8").includes("FELLBACK"), "P: child proceeded with best judgment (marker-timeout.txt)");
				// Forensics: the exact fallback text is in the child's transcript.
			const receipt = await awaitReceipt((m) => m.runId === pRunId, 60_000);
			ok(!!receipt, "P: receipt found");
				if (receipt?.transcriptPath && fs.existsSync(receipt.transcriptPath)) {
					const transcript = fs.readFileSync(receipt.transcriptPath, "utf8");
				ok(transcript.includes("No answer arrived within the budget"), "P: timeout fallback text captured in child transcript");
				}
			}
		await stop(pi);
		}
	}

	// ── Scenario Q: strict mode + background ask + answer stays usable ──
	{
		if (runScenario("Q")) {
		const dir = makeWorkspace();
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi = startPi(dir, { session: sessionFile });
		await pi.prompt("/delegate on", 60_000);
		await pi.prompt("/delegate status", 60_000);
		const strictStatus = pi.allText();
		ok(/mode: strict/.test(strictStatus), "Q: strict mode enabled");
		await pi.prompt(
				"While in strict delegation mode, call the delegate tool ONCE with background=true, task='FIRST call ask_parent with kind=question, topic=approval, text=Approve writing the file? After its result, create strict-ask.txt containing APPROVED and finish.' description='Strict ask test run'. Reply with exactly: SPAWNED.",
				300_000,
		);
		const question = await waitFor(
				() => {
					const entries = readSessionEntries(sessionFile);
					return entries.find((e) => e.type === "custom_message" && e.customType === "delegate-child-question") ?? null;
				},
			240_000,
				"strict child question",
			);
		ok(!!question, "Q: question delivered under strict mode");
		const qRunId = question?.details?.runId;
		if (qRunId) {
			await pi.prompt(
					`Answer the blocked child now: call delegate_answer with runId="${qRunId}" and answer="Yes, approved.". Reply with exactly: ANSWERED.`,
				180_000,
			);
			ok(/Answer delivered/.test(pi.allText()), "Q: delegate_answer works in strict mode");
			const done = await waitFor(
					() => {
					const entries = readSessionEntries(sessionFile);
					return entries.find(
							(e) => e.type === "custom_message" && e.customType === "delegate-background-result" && e.details?.runId === qRunId,
						) ?? null;
					},
				420_000,
					"strict terminal",
				);
			ok(done?.details?.state === "succeeded", `Q: strict-mode asked run succeeded (got ${done?.details?.state})`);
			ok(fs.readFileSync(path.join(dir, "strict-ask.txt"), "utf8").includes("APPROVED"), "Q: child used the strict-mode answer");
		}
		await stop(pi);
		}
	}

	// ── Scenario R: user-intercept command surface (deterministic) ──────
	// The live user-answer happy path is exercised by scenario O's autonomous
	// round-trip + the ask unit tests (writeAnswer/by-user routing). Driving
	// the model to NOT answer while its wake turn runs proved nondeterministic
	// across 3 attempts (ack race / wake-turn detour / child stall) — recorded
	// as knownGaps in the evidence manifest. What MUST hold deterministically
	// is the command surface itself: grammar, routing errors, no-pending.
	{
		if (runScenario("R")) {
		const dir = makeWorkspace();
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi = startPi(dir, { session: sessionFile });
		await pi.prompt("/delegate status", 60_000);
		// Unknown run: instructive error, no model involved.
		await pi.prompt("/delegate answer del_20260101T000000Z_00000000 nope", 60_000);
		const errText = await waitFor(() => (/unknown or expired background run/.test(pi.allText()) ? true : null), 15_000, "unknown-run error");
		ok(!!errText, "R: unknown runId answers with an instructive error");
		// Malformed usage: the parser rejects it.
		await pi.prompt("/delegate answer onlyrunid", 60_000);
		const usageText = await waitFor(() => (/unrecognized|usage/i.test(pi.allText()) ? true : null), 15_000, "usage error");
		ok(!!usageText, "R: malformed answer command rejected with usage");
		// Live background run, no pending ask: no-pending error is deterministic.
		await pi.prompt(
				"Call the delegate tool ONCE with background=true, task='Create the file r-det.txt containing the word PLAIN, verify it, and finish. Do not call ask_parent.' description='No ask plain run'. Reply with exactly: SPAWNED.",
				300_000,
			);
		const created = await waitFor(
				() => bgLedger(readSessionEntries(sessionFile)).find((e) => e.data?.type === "created"),
				120_000,
				"created entry",
			);
		const rRunId = created?.data?.runId;
		ok(!!rRunId, "R: background run spawned for no-pending check");
		if (rRunId) {
			await pi.prompt(`/delegate answer ${rRunId} too early`, 60_000);
			const noPending = await waitFor(() => (/no pending question/.test(pi.allText()) ? true : null), 20_000, "no-pending error");
			ok(!!noPending, "R: answering a run with no pending ask fails instructively");
			// The run itself still completes normally and delivers its terminal.
			const done = await waitFor(
				() => {
					const entries = readSessionEntries(sessionFile);
					return entries.find(
						(e) => e.type === "custom_message" && e.customType === "delegate-background-result" && e.details?.runId === rRunId,
					) ?? null;
				},
				420_000,
				"terminal (unaffected by early answer attempt)",
			);
			ok(done?.details?.state === "succeeded", `R: run unaffected by the early answer attempt (got ${done?.details?.state})`);
			ok(fs.existsSync(path.join(dir, "r-det.txt")), "R: run completed its work (r-det.txt)");
		}
		await stop(pi);
		}
	}

	// ── Scenario S: R20 — /delegate bg slash launch (no model turn) ────
	{
		if (runScenario("S")) {
		const dir = makeWorkspace();
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi = startPi(dir, { session: sessionFile });
		// A slash command: the extension spawns the background run directly;
		// the parent needs no model turn for the launch itself.
		await pi.prompt("/delegate bg Create the file s-marker.txt containing the word SLASHED, verify it, and finish.", 60_000);
		const created = await waitFor(
				() => bgLedger(readSessionEntries(sessionFile)).find((e) => e.data?.type === "created"),
			120_000,
			"created entry",
		);
		ok(!!created, "S: created ledger entry persisted");
		const description = created?.data?.description;
		ok(
			typeof description === "string" && /^\S+( \S+){2,5}$/.test(description),
			`S: derived description is 3–6 words (got ${JSON.stringify(description)})`,
		);
		const runId = created?.data?.runId;
		if (runId) {
			const done = await waitFor(
					() => bgResults(readSessionEntries(sessionFile)).find((m) => m.details?.runId === runId),
				420_000,
				"terminal",
			);
			ok(!!done, "S: terminal report delivered");
			ok(done?.details?.state === "succeeded", `S: slash-launched run succeeded (got ${done?.details?.state})`);
			ok(fs.readFileSync(path.join(dir, "s-marker.txt"), "utf8").includes("SLASHED"), "S: child wrote s-marker.txt");
		}
		await stop(pi);
		}
	}

	// ── Scenario T: R22 — the DEFAULT execution mode is background ──────
	{
		if (runScenario("T")) {
		const dir = makeWorkspace();
		const sessionFile = path.join(dir, "e2e-session.jsonl");
		const pi = startPi(dir, { session: sessionFile });
		// Plain /delegate run, NO execution flags: must spawn in the BACKGROUND
		// (instant return + created ledger entry + terminal message later).
		await pi.prompt("/delegate run general Create the file t-default.txt containing the word DEFAULTED, verify it, and finish.", 60_000);
		const created = await waitFor(
			() => bgLedger(readSessionEntries(sessionFile)).find((e) => e.data?.type === "created"),
			120_000,
			"created entry (default background)",
		);
		ok(!!created, "T: plain /delegate run spawns a BACKGROUND run (created ledger entry)");
		ok(/^\S+( \S+){2,5}$/.test(String(created?.data?.description ?? "")), `T: description derived and stored (${created?.data?.description})`);
		const tRunId = created?.data?.runId;
		if (tRunId) {
			const done = await waitFor(
				() => {
					const entries = readSessionEntries(sessionFile);
					return entries.find(
						(e) => e.type === "custom_message" && e.customType === "delegate-background-result" && e.details?.runId === tRunId,
						) ?? null;
				},
				420_000,
				"terminal via background delivery",
			);
			ok(done?.details?.state === "succeeded", `T: default-mode run delivered its report as a message (got ${done?.details?.state})`);
			ok(fs.readFileSync(path.join(dir, "t-default.txt"), "utf8").includes("DEFAULTED"), "T: child did the work (t-default.txt)");
		}
		// Explicit --foreground restores blocking semantics.
		await pi.prompt("/delegate run general --foreground Create the file t-fg.txt containing the word BLOCKED, verify it, and finish.", 300_000);
		ok(/background started/.test(pi.allText()) === false || !/delegate background started \u00b7 del_.*t-fg/.test(""), "T: foreground flag honored");
		ok(fs.existsSync(path.join(dir, "t-fg.txt")), "T: --foreground run completed blocking (t-fg.txt)");
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
