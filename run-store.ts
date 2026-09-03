/**
 * delegate — private run-store: paths, permissions, atomic metadata,
 * append-only evidence streams, retention, orphan recovery.
 *
 * Directory mode 0700, file mode 0600 (POL-006). Raw stdout JSONL and
 * stderr are append-only; metadata is atomically replaced on transitions.
 * Terminal states are immutable: a replacement may add final diagnostics
 * but never moves one terminal state to another (§9.1).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as childProcess from "node:child_process";
import type {
	DelegatePaths,
	DelegateRequest,
	RunMetadataV1,
	RunState,
	TranscriptRecordV1,
} from "./types.ts";
import { EMPTY_USAGE, isTerminalRunState } from "./types.ts";
import { atomicWriteJson } from "./config.ts";

export function makeRunId(now: Date = new Date()): string {
	// del_<UTC-basic-timestamp>_<8-random-hex>, e.g. del_20260901T143022Z_a1b2c3d4
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	const hex = crypto.randomBytes(4).toString("hex");
	return `del_${stamp}_${hex}`;
}

export function runPaths(agentDir: string, runId: string): DelegatePaths & {
	metadataPath: string;
	transcriptPath: string;
	stderrPath: string;
} {
	const runsDir = path.join(agentDir, "delegate", "runs");
	return {
		agentDir,
		configPath: path.join(agentDir, "delegate", "config.json"),
		runsDir,
		metadataPath: path.join(runsDir, `${runId}.json`),
		transcriptPath: path.join(runsDir, `${runId}.jsonl`),
		stderrPath: path.join(runsDir, `${runId}.stderr.log`),
	};
}

export function pathsForAgentDir(agentDir: string): DelegatePaths {
	const p = runPaths(agentDir, "");
	return { agentDir, configPath: p.configPath, runsDir: p.runsDir };
}

function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdir mode does not re-tighten existing directories; enforce 0700.
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// best effort on platforms without POSIX chmod semantics
	}
}

function assertSafeRunId(runId: string): void {
	if (!/^del_[0-9TZ]+_[0-9a-f]{8}$/.test(runId)) {
		throw new Error(`E_STORE: unsafe run id '${runId}'`);
	}
}

/**
 * Create a new run: metadata (created) + open append streams BEFORE spawn
 * so startup output is never lost. The caller owns the returned handles
 * and MUST close them in finally.
 */
export interface OpenedRun {
	metadata: RunMetadataV1;
	paths: ReturnType<typeof runPaths>;
	stdout: fs.WriteStream;
	stderr: fs.WriteStream;
}

export function openRun(agentDir: string, request: DelegateRequest): OpenedRun {
	const runId = makeRunId();
	const paths = runPaths(agentDir, runId);
	ensurePrivateDir(paths.runsDir);

	const metadata: RunMetadataV1 = {
		schemaVersion: 1,
		runId,
		state: "created",
		role: request.role,
		source: request.source,
		cwd: request.cwd,
		task: request.task,
		taskSha256: crypto.createHash("sha256").update(request.task, "utf8").digest("hex"),
		model: request.parentModel,
		thinkingLevel: request.thinkingLevel,
		createdAt: new Date().toISOString(),
		usage: { ...EMPTY_USAGE },
		transcriptPath: paths.transcriptPath,
		stderrPath: paths.stderrPath,
	};
	atomicWriteJson(paths.metadataPath, metadata);

	const stdout = openAppendStream(paths.transcriptPath);
	const stderr = openAppendStream(paths.stderrPath);
	return { metadata, paths, stdout, stderr };
}

export function openAppendStream(filePath: string): fs.WriteStream {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	// Open synchronously so fd exists before the first append — evidence is
	// durable even if completion is read immediately after finalize.
	const fd = fs.openSync(filePath, "a", 0o600);
	const mk = fs.createWriteStream as unknown as (
		source: unknown,
		options: { fd: number; autoClose: boolean },
	) => fs.WriteStream;
	return mk(undefined, { fd, autoClose: true });
}

/**
 * Append one captured raw stdout record to the transcript envelope.
 * Synchronous (O_APPEND) so evidence is durable before completion signals
 * are surfaced (§9). Returns the bytes written.
 */
export function appendTranscriptRecord(
	stdoutStream: fs.WriteStream,
	sequence: number,
	receivedAt: string,
	rawBytes: Buffer,
): void {
	let record: TranscriptRecordV1;
	try {
		// Normal case: the child emits valid UTF-8 JSON — keep it readable.
		record = {
			schemaVersion: 1,
			sequence,
			receivedAt,
			stream: "stdout",
			raw: new TextDecoder("utf-8", { fatal: true }).decode(rawBytes),
		};
	} catch {
		// Non-UTF-8 evidence is preserved verbatim, never dropped.
		record = {
			schemaVersion: 1,
			sequence,
			receivedAt,
			stream: "stdout",
			rawBase64: rawBytes.toString("base64"),
		};
	}
	const line = JSON.stringify(record) + "\n";
	const fd = (stdoutStream as unknown as { fd: number | null }).fd;
	if (typeof fd === "number") {
		fs.appendFileSync(fd, line, "utf8");
	} else {
		stdoutStream.write(line);
	}
}

/**
 * Atomically replace run metadata. Terminal states are immutable:
 * `next.state` must equal the current terminal state when the run is
 * already terminal (additional diagnostics may still be merged).
 */
export function updateRunMetadata(
	agentDir: string,
	runId: string,
	mutate: (current: RunMetadataV1) => Partial<RunMetadataV1>,
): RunMetadataV1 {
	assertSafeRunId(runId);
	const paths = runPaths(agentDir, runId);
	let current: RunMetadataV1;
	try {
		current = JSON.parse(fs.readFileSync(paths.metadataPath, "utf8")) as RunMetadataV1;
	} catch {
		throw new Error(`E_STORE: metadata missing for run ${runId}`);
	}
	const patch = mutate(current);
	if (
		patch.state !== undefined &&
		isTerminalRunState(current.state) &&
		patch.state !== current.state &&
		isTerminalRunState(patch.state)
	) {
		throw new Error(`E_STORE: terminal state ${current.state} is immutable for run ${runId}`);
	}
	const next: RunMetadataV1 = { ...current, ...patch };
	atomicWriteJson(paths.metadataPath, next);
	return next;
}

export function readRunMetadata(agentDir: string, runId: string): RunMetadataV1 | null {
	assertSafeRunId(runId);
	const paths = runPaths(agentDir, runId);
	try {
		return JSON.parse(fs.readFileSync(paths.metadataPath, "utf8")) as RunMetadataV1;
	} catch {
		return null;
	}
}

export interface RunSummary {
	runId: string;
	state: RunState;
	role: RunMetadataV1["role"];
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	mtimeMs: number;
}

/** List runs newest-first (by metadata mtime, falling back to createdAt). */
export function listRuns(agentDir: string, limit = 50): RunSummary[] {
	const p = pathsForAgentDir(agentDir);
	let names: string[];
	try {
		names = fs.readdirSync(p.runsDir);
	} catch {
		return [];
	}
	const summaries: RunSummary[] = [];
	for (const name of names) {
		const match = /^(del_[0-9TZ]+_[0-9a-f]{8})\.json$/;
		const m = name.match(match);
		if (!m) continue;
		const runId = m[1];
		try {
			const meta = JSON.parse(
				fs.readFileSync(path.join(p.runsDir, name), "utf8"),
			) as RunMetadataV1;
			if (meta.schemaVersion !== 1 || typeof meta.runId !== "string") continue;
			let mtimeMs = 0;
			try {
				mtimeMs = fs.statSync(path.join(p.runsDir, name)).mtimeMs;
			} catch {
				mtimeMs = 0;
			}
			summaries.push({
				runId,
				state: meta.state,
				role: meta.role,
				createdAt: meta.createdAt,
				startedAt: meta.startedAt,
				finishedAt: meta.finishedAt,
				durationMs:
					meta.startedAt && meta.finishedAt
						? Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)
						: undefined,
				mtimeMs,
			});
		} catch {
			// unreadable metadata: leave alone; retention will not touch it
		}
	}
	summaries.sort((a, b) => b.mtimeMs - a.mtimeMs || (b.createdAt > a.createdAt ? 1 : -1));
	return summaries.slice(0, limit);
}

/**
 * Signal-0 liveness probe: `process.kill(pid, 0)` sends no signal. EPERM
 * means the pid exists (owned by another user) — treat as alive; ESRCH and
 * any other error mean the pid is gone.
 */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Best-effort read of another process's command line:
 *  - Linux: /proc/<pid>/cmdline (NUL-separated args);
 *  - elsewhere (macOS): `ps -o args= -p <pid>` (single line, no header).
 * Returns null when the pid is dead or the cmdline cannot be read.
 */
export function pidCommandLine(pid: number): string | null {
	if (!isPidAlive(pid)) return null;
	if (process.platform === "linux") {
		try {
			const text = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
				.replace(/\0+/g, " ")
				.trim();
			return text.length > 0 ? text : null;
		} catch {
			return null;
		}
	}
	try {
		const out = childProcess.spawnSync("ps", ["-o", "args=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2_000,
		});
		if (out.error || out.status !== 0) return null;
		const text = (out.stdout ?? "").trim();
		return text.length > 0 ? text : null;
	} catch {
		return null;
	}
}

/**
 * True when the command line belongs to a Pi process (a delegate child, or
 * a concurrent pi parent owning a run): any whitespace-split token whose
 * path basename is exactly `pi` (covers `pi --mode rpc ...`,
 * `/opt/homebrew/bin/pi ...`, `node /opt/homebrew/bin/pi ...`), or a path
 * under the pi-coding-agent package (covers
 * `node .../pi-coding-agent/dist/bundle/cli.js ...`).
 */
export function commandLineIsPi(cmdline: string): boolean {
	for (const token of cmdline.trim().split(/\s+/)) {
		if (token && path.basename(token) === "pi") return true;
	}
	return cmdline.includes("pi-coding-agent");
}

/**
 * Startup orphan recovery (§10.6): nonterminal metadata whose owned process
 * is gone becomes `crashed` with E_ORPHANED_RUN. This process NEVER kills a
 * PID found in stale metadata.
 *
 * P1: a live pi process owns its runs — concurrent multi-session pi (the
 * pattern documented in AGENTS.md) must never clobber a run that another
 * live pi process is actively running or finalizing. Decision table per
 * nonterminal run:
 *  - no stored pid, or pid dead          → mark crashed (unchanged);
 *  - pid alive, cmdline is pi            → SKIP (live delegate owner);
 *  - pid alive, cmdline known, not pi    → mark crashed (recycled PID);
 *  - pid alive, cmdline unreadable       → SKIP (fail-safe: never clobber on doubt).
 * Returns the touched run IDs.
 */
export function markOrphanedRuns(agentDir: string): string[] {
	const touched: string[] = [];
	for (const summary of listRuns(agentDir)) {
		if (isTerminalRunState(summary.state)) continue;
		try {
			const storedPid = readRunMetadata(agentDir, summary.runId)?.pid;
			if (typeof storedPid === "number" && isPidAlive(storedPid)) {
				const cmdline = pidCommandLine(storedPid);
				if (cmdline === null) continue; // fail-safe: alive but unreadable
				if (commandLineIsPi(cmdline)) continue; // live pi owner
				const next = updateRunMetadata(agentDir, summary.runId, (current) => ({
					state: "crashed",
					errorCode: "E_ORPHANED_RUN",
					errorMessage: `Run store started with this run nonterminal; stored pid ${storedPid} is alive but not a pi process (recycled pid), so the run has no owner.`,
					finishedAt: current.finishedAt ?? new Date().toISOString(),
				}));
				if (next.state === "crashed") touched.push(summary.runId);
			} else {
				const next = updateRunMetadata(agentDir, summary.runId, (current) => ({
					state: "crashed",
					errorCode: "E_ORPHANED_RUN",
					errorMessage: "Run store started with this run nonterminal and no owned child process.",
					finishedAt: current.finishedAt ?? new Date().toISOString(),
				}));
				if (next.state === "crashed") touched.push(summary.runId);
			}
		} catch {
			// skip
		}
	}
	return touched;
}

/**
 * Retention (§10.6): remove oldest terminal runs until BOTH maxRuns and
 * maxRunAgeDays are satisfied. Never removes active/nonterminal runs from
 * the current process (pass `protectedRunId`) or files that cannot be
 * confidently associated with a valid run ID. Failures are warning-only.
 */
export function enforceRetention(
	agentDir: string,
	maxRuns: number,
	maxRunAgeDays: number,
	protectedRunId?: string,
): { removed: number; warnings: string[] } {
	const warnings: string[] = [];
	let removed = 0;
	const p = pathsForAgentDir(agentDir);
	let all: RunSummary[];
	try {
		all = listRuns(agentDir, 10_000);
	} catch (error) {
		return { removed: 0, warnings: [`E_STORE: could not list runs: ${(error as Error).message}`] };
	}

	const now = Date.now();
	const ageCutoff = now - maxRunAgeDays * 86_400_000;

	// Terminal, non-protected runs, oldest first — two independent rules:
	// age (older than cutoff) and count (oldest surplus beyond maxRuns).
	const ordered = all
		.filter((s) => isTerminalRunState(s.state) && s.runId !== protectedRunId)
		.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.createdAt < b.createdAt ? -1 : 1));

	const terminalCount = all.filter((s) => isTerminalRunState(s.state)).length;
	const surplus = Math.max(0, terminalCount - maxRuns);
	const ageRemove = ordered.filter((s) => new Date(s.createdAt).getTime() < ageCutoff);
	const countRemove = ordered.slice(0, surplus);
	const toRemove = [...new Set([...ageRemove, ...countRemove])];

	for (const candidate of toRemove) {
		const files = [
			path.join(p.runsDir, `${candidate.runId}.json`),
			path.join(p.runsDir, `${candidate.runId}.jsonl`),
			path.join(p.runsDir, `${candidate.runId}.stderr.log`),
		];
		try {
			for (const file of files) {
				if (fs.existsSync(file)) fs.unlinkSync(file);
			}
			removed += 1;
		} catch (error) {
			warnings.push(
				`E_STORE: retention could not remove ${candidate.runId}: ${(error as Error).message}`,
			);
		}
	}
	return { removed, warnings };
}
