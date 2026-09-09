/**
 * delegate — loaded-version provenance (R7).
 *
 * A running Pi session keeps whatever extension code it loaded at startup;
 * newer npm-store installs only apply after /reload. Every result header
 * and /delegate status therefore carries the version actually executing,
 * so "stale copy in this process" is self-evident instead of mysterious.
 *
 * Thin wrapper (S2) over the canonical helper vendored at `ui/version.ts`
 * (kit source: `skills/pi-extension-builder/assets/control-panel/…`); the
 * public name and return string are unchanged — the package.json path is
 * resolved from THIS module's URL, as before.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { extensionVersion } from "./ui/version.ts";

export function delegateVersion(): string {
	return extensionVersion({
		packageJsonPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"),
	});
}
