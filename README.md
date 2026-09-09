# @maheidem/pi-delegate

Foreground isolated delegation + strict coordinator mode for the
[pi coding agent](https://github.com/earendil-works/pi) (`pi-coding-agent`).
Implements `PI-DELEGATE-TS-001` (Part II normative).

`delegate` runs a bounded task in a **separate child pi process** over the
documented RPC stdio protocol, returns a **bounded handoff** (capped text +
structured metadata, full transcript on disk), and can put the parent session
into a **strict coordinator mode** where the parent may only delegate — the
gate is an allowlist and exceptions fail closed.

## Install (source of truth: this workspace)

```bash
# development: run from a pi session in this repo
pi   # /delegate is auto-discovered from .pi/extensions or ~/.pi/agent/extensions
```

Register globally by copying/symlinking `custom-extensions/delegate` into
`~/.pi/agent/extensions/delegate` and adding it to
`~/.pi/agent/settings.json → packages`, then `/reload`. No automated install
is performed by this package.

## Usage

```text
/delegate                          dashboard (TUI) / status (headless)
/delegate run general <task>      foreground delegation (impl specialist)
/delegate research <task>         foreground web research (read-only tools)
/delegate on                      enable strict coordinator mode (session,
                                    tree-stable; active tool set becomes
                                    ['delegate'])
/delegate off                     disable strict coordinator mode
/delegate status                  mode, active/last run, tool registration,
                                    executing version (R7)
/delegate inspect [runId]         metadata + bounded transcript/stderr
/delegate cancel [runId]          cancel the active (or named) run
/delegate resume <runId> <task>   continue a prior run's child session in the
                                    SAME context (R3) — no cold re-explanation
/delegate paths                   config/run-store locations
/delegate doctor                  honest environment checks
/delegate help                    syntax + examples
```

Any unrecognized first word is shorthand for `run general …`.

### Terminal UI (v0.3.0)

One centralized experience built on the vendored canonical `SettingsPanel`
(never a bespoke panel). Everything reachable from the panel is also reachable
as a nested command and from headless stdout — the same application method.

- **Home dashboard** (`/delegate`, TUI) — health summary (version · mode,
  active/idle, last run) + **Actions** (Run general/research, Peek, Cancel,
  Resume, strict toggle, `Configure advanced… ›`, Doctor, Paths) + base
  **Timeouts** (user & project). Keys: `↑↓/jk` move, `enter` select, `esc/q`
  close; shortcuts `r run · p peek · x cancel · c configure · d doctor · s status`.
- **Live dashboard** — while a run is active the home panel mirrors it live
  (`refresh` 1 s): phase · short model · fixed progress bar · tokens
  `↑in ↓out` (primary) · `$cost` (secondary, dim) · in-flight tools · tail.
- **Inline execution (both paths).** Slash path shows a fixed-height strip
  above the composer (`RunningView`) with progress, in-flight and a feed; the
  model path renders the same liveness through the tool's `renderCall` /
  `renderResult`. Terminal results render as a neutral card — `✓ done`,
  `⊘ cancelled`, `⏱ timeout · idle/hard`, `✗ failed` — glyph+word (never a
  bare `error:`), tokens primary, with a partial-handoff tail + resume hint
  on cancel/timeout.
- **Peek** (`/delegate peek [runId]`) — detailed fixed-height overlay
  (`PeekView`, full model id, relative-stamped event feed); `q` returns home.
- **Advanced config** (`Configure advanced… ›`) — queue limit, stuck-tool
  watchdog, kill/handoff grace/enforce, max task/result bytes, default role —
  edited through the same generic `patchConfig`; `esc` returns home.
- **Destructive actions** (cancel, strict on/off) require confirmation.

Headless (`pi -p` / child mode) prints the same status/doctor/paths text, so
panel ≡ command ≡ headless. Screens with pixel evidence live in
`.planning/ui-redesign-2026-09-04/evidence/` (see `manifest.json`).

### Timeouts

Three levels, highest priority first:

1. **Per-invocation flag** — `--timeout <90s|10m|2h|1d|ms>` anywhere in the
   task (e.g. `/delegate run general long migration --timeout 2h`). The
   `delegate` tool exposes the same as its optional `timeout` parameter, so
   the parent model can extend the budget when it expects a long subtask.
   Clamped to the configured `hardTimeoutMs` bounds; the inactivity timeout
   scales to at most half of it.
2. **Project-wide** — `<project>/.pi/delegate/config.json` overlays the user
   config field-by-field (only listed keys override; e.g.
   `{ "hardTimeoutMs": 7200000 }`). A missing or corrupt project file never
   breaks delegations — user values win and corruption is diagnosed.
3. **User-wide** — `~/.pi/agent/delegate/config.json`
   (`hardTimeoutMs` default 30 min, `inactivityTimeoutMs` default 5 min).

The dashboard (`/delegate`) shows the effective base timeout with its source
(`user-wide` or `project`) and has an editable **Timeouts (base)** section:
`Hard · user-wide`, `Hard · project` (merges one key into
`<project>/.pi/delegate/config.json`), and `Idle · user-wide` (the no-output
watchdog, capped at half of the hard timeout for any source). Inputs accept
durations (`30m`, `2h`, `1d`) or bare ms. Headless `/delegate status` prints
the same base-timeout line.

Tool (`delegate`) is available to models: same semantics, JSON result with
`ok`/`handoff`/`details` (usage, paths, state) or structured `error`.

### Timeout semantics (read this before long validation/benchmark runs)

Effective budgets per run, resolved as `per-invocation > project > user`:

- **Hard** — wall-clock cap for the whole run (`hardTimeoutMs`, default 30 m).
- **Idle** — no child output at all, with **no tool call in flight**
  (`inactivityTimeoutMs`, default 5 m), **capped at hard/2** for any source.
- **Stuck-tool** — no child output **while a tool call is in flight**
  (`stuckToolTimeoutMs`, default = the hard timeout). A silent 40-minute test
  matrix inside one `bash` call is *activity*, not a stall: the watchdog
  leaves it alone until the stuck-tool budget (or the hard cap) is reached.

Consequences worth internalizing:

- A single tool call longer than **min(idle, hard/2)** used to be
  *guaranteed killed* — that was the single largest failure class in the
  2026-09-03 investigation (5 of 11 failures, 0 true positives). In-flight
  tools now sit under the stuck-tool budget instead.
- Per-run `--timeout` / the `timeout` parameter raises the hard cap **and**
  (through the hard/2 cap) the idle cap. For long validation or benchmark
  work, set `timeout` ≥ 2× the longest expected single tool call.
- A genuinely silent child with no open tool still trips the idle watchdog
  exactly as before.

### Graceful timeout handoff (R2), durable sessions (R3), provider errors (R4)

- On a **timeout kill**, the runner no longer goes straight to SIGTERM: it
  aborts the in-flight turn, sends a bounded termination-notice prompt
  ("files changed / work remaining / last verification state — answer from
  context, no tools"), waits `handoffGraceMs` (default 90 s), and captures
  the answer as **`partialHandoff`** on the receipt and in the tool result.
  Post-mortem inspection becomes "read the handoff", not "re-read the tree".
- Child sessions are **durable**: each run persists the child's pi session
  under `<runsDir>/sessions/` and records `sessionPath` on the receipt.
  `delegate({ resumeFrom: runId })` or `/delegate resume <runId> <task>`
  re-enters that exact session — the new child sees all earlier turns, so a
  killed run continues with **one prompt** instead of a cold re-explained
  task. (Pre-0.2.0 runs have no session file and are not resumable.)
- Provider failures are diagnosed from the provider's own
  `errorMessage` on the final message (`E_PROVIDER_ERROR`, verbatim text —
  e.g. `Codex error: The usage limit has been reached`). Abort artifacts
  (`This operation was aborted`) are classified as killed-by-watchdog rather
  than blamed on the provider, and the stderr tail is no longer presented as
  the cause.

### Background delegation (v0.5.0, R8–R15)

`delegate({ background: true, description: "…" })` runs the delegation
**asynchronously**: the tool call returns a runId immediately, the parent turn
continues, and the terminal report is delivered later as a message that wakes
an idle parent (`deliverAs: "steer"`, `triggerTurn: true`) or steers a busy
one. The envelope explicitly tells the parent model to treat reports as
internal work events.

- **Concurrency**: up to `maxBackgroundRuns` (default 3, clamp 1–8, dashboard +
  project overlay) children run **in parallel**, separate from the foreground
  one-child queue. Overflow fails fast with `E_BACKGROUND_FULL` — background
  calls are never queued.
- **`description`** is required (3–6 words, single line) and rides every header.
- **Model surface**: the `delegate_status` tool lists live background runs
  (slots, phase, elapsed, in-flight tool) and per-run detail with the activity
  tail, handoff preview, and the `resumeFrom` hint for interrupted runs.
  `/delegate status` prints the same inventory; the dashboard gains a
  **Background runs** section and the footer shows `▴Nbg`.
- **Ownership + delivery** (pi-async-fork pattern, no daemon): `delegate.background`
  custom entries in the session JSONL are the branch-scoped ledger; terminal
  delivery is at-least-once with details-scan dedup; a restart reconciles the
  branch, re-delivers undelivered terminals exactly once, reports runs owned
  by other live sessions, and turns dead-pid orphans into resumable
  interrupted reports. Branch switches pause delivery; the extension never
  delivers into a session the run's branch doesn't own.
- **Rendered results**: delivered reports render as neutral glyph+word cards
  (`✓ completed / ⚠ failed / ⏱ timed out / ⊘ cancelled`) with the model-only
  classification sentence stripped from display.
- Headless note: background works, but a `pi -p` process exit kills in-flight
  children — receipts finalize interrupted/resumable. Prefer foreground for
  one-shot headless flows.

### Concurrent calls queue (fan-out just works)

Models naturally issue several `delegate` calls in one turn. Pi executes
them truly in parallel; delegate runs **one child at a time** and places
concurrent calls in a bounded FIFO queue (`queueLimit`, default 3): a 4-way
fan-out becomes 4 back-to-back children and 4 real results — no error
storm. Aborting a still-queued call removes it (resolved as `cancelled`,
never spawned). Beyond the limit the call fails fast with an instructive
`E_DELEGATE_BUSY` ("wait for the in-flight results, then re-issue").
`/delegate status` shows the queue depth.

### Watching a child work: the live feed and `/delegate peek`

- **Foreground `/delegate run` (TUI)** opens a live feed panel: identity
  (`role · model · elapsed · turn N · ↑in ↓out`), an elapsed-vs-hard-cap
  progress bar, in-flight tools, and a scrolling one-line-per-event feed of
  the child's activity — `▶ bash npm test` → `✓ … (38s)`, `✎` assistant
  lines, `⚠` provider errors, `▣` handoff submissions. Escape twice cancels.
- **`/delegate peek [run-id]`** opens the same feed decoded from the run's
  captured transcript — live-following (`● live`) while the run is active,
  scrollable (`j`/`k`, `f` re-follow, `q` close), and equally useful
  post-mortem on any finished run. Headless/print mode prints the tail.

### The mandatory structured handoff (protocol, not prompt)

Anything the harness NEEDS from the child is a validated protocol step —
never free text we hope has the right shape:

- The delegate extension loads in child mode too and registers exactly one
  tool: **`handoff`** (always in the child's tool ceiling). The child's run
  does not complete until it submits a structured report:
  `outcome` (`done|partial|blocked`), `summary`, `changes[]`
  (`path`/`action`/`note`), `verification[]` (`command`/`result`/`note`),
  `remaining[]` (required unless `done`), `risks[]`.
- **Malformed submissions fail as tool errors** listing every invalid field,
  so the child retries with the exact problems named.
- A child that settles **without** submitting is re-prompted automatically
  (bounded: 2 attempts, `handoffEnforceTimeoutMs` deadline — never the hard
  cap), then its free-text ending is accepted with a diagnostic note
  (older children without the tool still finish).
- The parent-facing handoff text is **rendered deterministically** from the
  validated fields; the receipt stores the raw structured payload as
  `handoffData`. The kill-time partial handoff (R2) uses the same tool, so a
  timed-out child's last act is a machine-checkable report.

### Model pinning (R5), git checkpoints (R6), version provenance (R7)

- `delegate({ model: "provider/model-id" })` pins the child model. Without
  it the child silently inherits the parent's **current** model — if the
  parent falls back mid-session (e.g. a usage limit), every child follows.
  The resolved child model is echoed in live updates and the result header.
- When the cwd is a git worktree, every receipt records `gitBase` (HEAD at
  run start), `gitStatus` (pre-run dirty files) and `gitDelta` (post-run
  `git diff --stat HEAD` + untracked files). "What did the dead child
  change?" is `git diff <gitBase>`.
- Every result header and `/delegate status` prints the **executing**
  extension version. Extensions load at session start: newer installs only
  apply after `/reload` in that session — the version line makes a stale
  copy self-evident instead of indistinguishable from a regression.

## Safety model (selected invariants)

- The delegated task travels over child **RPC stdin**, never argv.
- Children run with `PI_DELEGATE_CHILD=1`; the extension is inert in children
  (no recursion, no nested delegation).
- `agent_settled` is the only normal completion signal; raw stdout records are
  persisted **before** semantic processing; unknown events are persisted and
  ignored, never dropped.
- Cancellation is idempotent (first wins): RPC abort → SIGTERM → SIGKILL;
  every finalization reaps the child exactly once.
- Startup orphan recovery only marks a nonterminal run `crashed` /
  `E_ORPHANED_RUN` when its stored pid is dead or provably not a pi process
  (recycled pid). A live pi process owns its runs — a concurrent pi session
  (the multi-session pattern) never clobbers a run that another live pi
  process is running or finalizing; live pids with unreadable command lines
  are left alone (fail-safe, never clobber on doubt). This process never kills
  a pid it finds in stale metadata.
- Every terminal failure state carries a specific error payload: timeout and
  cancel states reached without one (timers, user cancels) synthesize
  `E_TIMEOUT_IDLE` / `E_TIMEOUT_HARD` / `E_CANCELLED` with a descriptive
  message at finalization, in both the receipt and the tool text — the error
  line never degrades to `unknown failure`.
- Run-store is `0700` with `0600` receipt/transcript/stderr files; corrupt
  config is preserved as evidence and defaults are loaded. Manual data
  repairs are recorded on the receipt in a `curationNote` field (one-time
  2026-09-03 repair: receipts clobbered by pre-0.1.5 orphan recovery and
  later removed by retention were reconstructed from the parent sessions'
  delegate tool results — see `.planning/`, excluded from the npm tarball).
- Strict mode is session-scoped, replayed per branch (tree/resume/fork safe),
  persisted via session custom entries; persistence failures degrade loudly
  but never silently disable the gate.
- Research requires a Firecrawl-capable tool path in the parent session;
  Reddit is supplementary.

## Development

```bash
npm run typecheck   # strict tsc, no emit
npm test            # unit + runner (real RPC children) + application + UI + load
npm run test:e2e    # real pi session E2E (needs a working default model)
                    # E2E_SCENARIOS=D,F runs a targeted subset
```

Design: `types.ts`/`config.ts`/`mode.ts`/`run-store.ts`/`rpc-jsonl.ts`/
`runner.ts`/`application.ts` are Pi-free domain modules; `index.ts` is the
sole Pi adapter (loads through jiti exactly as pi loads extensions; registers
only `/delegate`, the `delegate` tool, and the `delegate-handoff` renderer).

## Provenance / attribution

Built against `@earendil-works/pi-coding-agent` 0.84.4 and its official
`subagent` and `plan-mode` extension examples (MIT). `ui/settings-panel.ts`
is vendored from the local `/loop` extension's control panel (same author,
same workspace; pi-extension-builder v0.1.0 template). RPC protocol shapes
follow the installed pi RPC documentation (`docs/rpc.md`) in
`@earendil-works/pi-coding-agent`.
