/**
 * delegate load test — loads index.ts through the same jiti loader Pi uses,
 * asserts the factory registers exactly ONE command (/delegate) and ONE
 * tool (delegate), plus the gate and lifecycle handlers; inert in children.
 */
import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

function isolatedAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "delegate-load-"));
}

async function loadFactory() {
	let jitiPath: string;
	try {
		jitiPath = require_.resolve("jiti");
	} catch {
		jitiPath = require_.resolve("jiti", {
			paths: [path.join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent")],
		});
	}
	const jitiMod = await import(jitiPath);
	const jiti = (jitiMod.createJiti ?? jitiMod.default)(import.meta.url, { interopDefault: true });
	const mod = await jiti.import(path.join(here, "..", "index.ts"));
	return (mod as { default?: unknown }).default;
}

function mockPi() {
	const commands: string[] = [];
	const tools: string[] = [];
	const toolDefs: Array<{ name: string; promptSnippet?: unknown }> = [];
	const events: string[] = [];
	const messageRenderers: string[] = [];
	return {
		commands,
		tools,
		toolDefs,
		events,
		get messageRenderers() {
			return messageRenderers;
		},
		registerCommand: (name: string) => commands.push(name),
		registerTool: (def: { name: string; promptSnippet?: unknown }) => {
			tools.push(def.name);
			toolDefs.push(def);
		},
		on: (event: string) => events.push(event),
		registerMessageRenderer: (type: string) => {
			messageRenderers.push(type);
		},
	};
}

test("load: registers exactly /delegate + delegate tool (no aliases)", async () => {
	process.env.PI_DELEGATE_AGENT_DIR = isolatedAgentDir();
	const factory = await loadFactory();
	assert.equal(typeof factory, "function");
	const pi = mockPi();
	(factory as (pi: unknown) => void)(pi);
	assert.deepEqual(pi.commands, ["delegate"]);
	// R14/R16/R17 (async spec): the background tool set joins the registration inventory.
	assert.deepEqual(pi.tools, ["delegate", "delegate_status", "delegate_send", "delegate_answer"]);
	// R14/R15/R17/R18 (async spec): the message-renderer inventory, in source
	// registration order (order-sensitive deepEqual against the mock).
	assert.deepEqual(pi.messageRenderers, [
		"delegate-child-question",
		"delegate-child-note",
		"delegate-handoff",
		"delegate-background-progress",
		"delegate-background-result",
	]);
	for (const ev of ["tool_call", "session_start", "session_tree", "before_agent_start", "turn_start", "session_shutdown"]) {
		assert.ok(pi.events.includes(ev), `missing handler ${ev}`);
	}
});

test("load: inert when PI_DELEGATE_CHILD=1", async () => {
	process.env.PI_DELEGATE_AGENT_DIR = isolatedAgentDir();
	process.env.PI_DELEGATE_CHILD = "1";
	try {
		const factory = await loadFactory();
		const pi = mockPi();
		(factory as (pi: unknown) => void)(pi);
		assert.deepEqual(pi.commands, []);
		// Child mode registers EXACTLY the mandatory structured-handoff tool.
		assert.deepEqual(pi.tools, ["handoff"]);
	} finally {
		delete process.env.PI_DELEGATE_CHILD;
	}
});

// Pi >= 1.0 lists an extension tool in the system prompt only when it has a
// promptSnippet. A tool without one is invisible to small models.
test("load: every registered tool (parent + child + ask_parent) has a non-empty promptSnippet", async () => {
	process.env.PI_DELEGATE_AGENT_DIR = isolatedAgentDir();
	const factory = await loadFactory();
	const parent = mockPi();
	(factory as (pi: unknown) => void)(parent);
	process.env.PI_DELEGATE_CHILD = "1";
	process.env.PI_DELEGATE_ASK_DIR = isolatedAgentDir();
	const child = mockPi();
	try {
		(factory as (pi: unknown) => void)(child);
	} finally {
		delete process.env.PI_DELEGATE_CHILD;
		delete process.env.PI_DELEGATE_ASK_DIR;
	}
	assert.deepEqual(child.tools, ["handoff", "ask_parent"]);
	const defs = [...parent.toolDefs, ...child.toolDefs];
	assert.equal(defs.length, 6);
	for (const def of defs) {
		assert.ok(typeof def.promptSnippet === "string" && def.promptSnippet.trim().length > 0, `tool ${def.name} has no promptSnippet`);
	}
});
