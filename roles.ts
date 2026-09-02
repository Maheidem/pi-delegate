/**
 * delegate — closed role catalogue.
 *
 * Roles are immutable package assets in v1. Project-defined overrides are a
 * non-goal; the catalogue is the only source of role prompts and tool
 * ceilings.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as url from "node:url";
import type { DelegateRole, RoleName } from "./types.ts";
import { ROLE_NAMES } from "./types.ts";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

const GENERAL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const RESEARCH_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"mcp",
	"mcpScript",
	"mcp__firecrawl",
	"mcp__reddit",
] as const;

export const DELEGATE_ROLES: Record<RoleName, DelegateRole> = {
	general: {
		name: "general",
		description:
			"Write-capable generalist: implements, inspects, edits, and verifies bounded code tasks in the shared working tree.",
		promptPath: path.join(HERE, "roles", "general.md"),
		tools: GENERAL_TOOLS,
		writeCapable: true,
	},
	research: {
		name: "research",
		description:
			"Read-only research specialist: Firecrawl is the primary web-research path, Reddit supplements; preserves sources and distinguishes facts from inference.",
		promptPath: path.join(HERE, "roles", "research.md"),
		tools: RESEARCH_TOOLS,
		writeCapable: false,
	},
};

export function isRoleName(value: unknown): value is RoleName {
	return typeof value === "string" && (ROLE_NAMES as readonly string[]).includes(value);
}

/**
 * Validate and return a role. Accepts exact role names; undefined selects
 * the default. Anything else throws an E_INVALID_ROLE message.
 */
export function resolveRole(name: unknown, defaultRole: RoleName): DelegateRole {
	if (name === undefined || name === null || name === "") return DELEGATE_ROLES[defaultRole];
	if (!isRoleName(name)) {
		throw new Error(
			`E_INVALID_ROLE: role '${String(name)}' is not in the closed catalogue (${ROLE_NAMES.join(", ")})`,
		);
	}
	return DELEGATE_ROLES[name];
}

/**
 * Intersect a role's ceiling with the tools actually registered in the
 * child. Research requires at least one Firecrawl-capable path when the
 * child has MCP registration at all; the adapter checks availability
 * against the parent's MCP surface before spawn.
 */
export function intersectRoleTools(role: DelegateRole, registeredTools: readonly string[]): string[] {
	const available = new Set(registeredTools);
	const kept: string[] = [];
	for (const tool of role.tools) {
		if (available.has(tool)) kept.push(tool);
		else {
			// Namespace proxies may be absent when the underlying MCP
			// server is not registered; the generic `mcp` gateway is
			// accepted as the fallback path (see §7.2).
			if (tool.startsWith("mcp__") && available.has("mcp")) continue;
		}
	}
	return kept;
}

export function rolePromptExists(role: DelegateRole): boolean {
	try {
		return fs.statSync(role.promptPath).isFile();
	} catch {
		return false;
	}
}
