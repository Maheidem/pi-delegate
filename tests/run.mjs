/**
 * delegate test runner — runs every tests/*.test.mjs in a clean child
 * process (`node --test`). Exit code reflects failures.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Env guard: tests must run in PARENT mode; when npm test is inherited by a delegated child session ANY Pi_DELEGATE_* marker leaks in and flips child/background behavior (PI_DELEGATE_ASK_DIR once made the load/runner tests fail inside a background child — the suite looked "red at HEAD" only from inside the child). Strip the whole family.
for (const k of Object.keys(process.env)) if (k.startsWith("PI_DELEGATE_")) delete process.env[k];
const files = fs.readdirSync(here).filter((f) => f.endsWith(".test.ts")).sort();
if (files.length === 0) {
	console.error("no tests found");
	process.exit(1);
}
const args = ["--test"];
for (const filter of process.argv.slice(2)) args.push("--test-name-pattern", filter);
const result = spawnSync(process.execPath, [...args, ...files.map((f) => path.join(here, f))], {
	stdio: "inherit",
	cwd: path.join(here, ".."),
	env: { ...process.env, NODE_NO_WARNINGS: "1" },
});
process.exit(result.status ?? 1);
