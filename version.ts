/**
 * delegate — loaded-version provenance (R7).
 *
 * A running Pi session keeps whatever extension code it loaded at startup;
 * newer npm-store installs only apply after /reload. Every result header
 * and /delegate status therefore carries the version actually executing,
 * so "stale copy in this process" is self-evident instead of mysterious.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function delegateVersion(): string {
	if (cached) return cached;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")) as {
			version?: string;
		};
		cached = pkg.version ?? "unknown";
	} catch {
		cached = "unknown";
	}
	return cached;
}
