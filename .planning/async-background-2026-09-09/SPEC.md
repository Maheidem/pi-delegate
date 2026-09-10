# delegate — async/background delegation + bidirectional child channels (2026-09-09)

Status: APPROVED — user sign-off 2026-09-09 (canonical workflow step 3 complete).
Implementation entry point: `GOAL-PROMPT.md` (same directory) in a fresh `/goal` session.
Baseline: 0.3.2 @ `custom-extensions/delegate/` (npm `@maheidem/pi-delegate`; check the
agent-global store copy for what Pi actually runs).
Extends: `PI-DELEGATE-TS-001` (R1–R7 already shipped). This spec adds **R8–R20**.
Prior art studied at source level: [elpapi42/pi-async-fork](https://github.com/elpapi42/pi-async-fork)
(master, 40 commits; clone in `/tmp/pi-async-fork` during research) — see §1 and §14.

---

## 0. Summary

`delegate` today is **foreground**: the `delegate` tool call blocks until the child
settles; parallel calls serialize through a one-child FIFO queue. This spec makes
delegation **asynchronous**:

```text
today:     delegate → wait → result → continue
after R8:  delegate(background) → runId → continue → terminal report arrives later as a message
```

and **bidirectional** (Phase 2): background children can be steered by the parent
(`delegate_send`), can ask the parent blocking questions (`ask_parent` kind
`question`, answered via `delegate_answer`), and can file non-blocking notes
(`ask_parent` kind `note`). The parent model remains the orchestrator and the
decision-maker; children never gain authority, only a channel.

Design constraint honored throughout: **the existing runner is the runtime.** We do
not adopt pi-fleet or any daemon. Everything new rides the existing RPC child,
the structured `handoff` protocol, the run store, and documented pi extension
APIs (`pi.sendMessage`, `pi.appendEntry`, `registerMessageRenderer`,
`ctx.sessionManager.getBranch()`, `session_before_tree`/`session_tree`).

---

## 1. Prior art: pi-async-fork — adopted vs. rejected

pi-async-fork runs durable forks in **pi-fleet** (the author's separate runtime:
daemonized workers, LMDB activity journal, crash recovery) and coordinates them
from a thin extension (`src/forks/controller.ts` is the async brain).

### Adopted (mechanism, not dependency)

| Mechanism | Where in pi-async-fork | Our equivalent |
|---|---|---|
| Non-blocking tool returns fork ID | `index.ts` `create_fork` | `delegate({background:true})` returns runId (R8) |
| Result delivery via `pi.sendMessage({deliverAs:"steer", triggerTurn})` | `forks/delivery.ts` | `delegate-background-result` messages (R10) |
| Progress never wakes; terminals wake | `delivery.ts` `triggerTurn: kind !== "progress"` | notes = never wake; results & questions = wake (R10, R17, R18) |
| Session-JSONL ledger + root-to-tip projection | `forks/ledger.ts` `project(getBranch())` | `delegate.background` entries, branch-scoped ownership (R11) |
| At-least-once delivery + dedup by details scan | `ledger.ts` `isDelivered()` | re-send undelivered terminal results after restart (R12) |
| Generation guard, tree pause/resume | `controller.ts` `#generation`, `beforeTree/afterTree` | BackgroundManager generation + pause (R13) |
| Serialized delivery (promise tail) | `delivery.ts` `#tail` | same pattern (R10) |
| Model-visible envelope with "internal work event" discipline | `delivery.ts` `formatOutput` | exact envelopes in §5 (R10) |
| Custom message renderer with clean headers | `forks/render.ts` | neutral glyph+word cards (R15) |
| Configurable child count tiers | config `fast/balanced/deep` | `maxBackgroundRuns` (R9) |
| Validated 3–6-word `description` | `identity.ts` `validateDescription` | same validation for background runs (R8) |

### Rejected (with reasons)

| pi-async-fork choice | Why we reject it |
|---|---|
| pi-fleet daemon as worker runtime | Third-party companion runtime would replace our RPC protocol, deterministic `handoff` enforcement, watchdogs, role ceilings, receipts — the parts that already work. Durability across parent exit is served by existing sessions + `resumeFrom` in Phase 1/2; Phase 3 (own detached runner) only if a real need appears (§13). |
| Child session forked from parent context (`session.ts`) | Deliberate non-goal: delegate's contract is "the child does not see parent history". Task text carries all needed context. |
| Report classification heuristic (held candidates + 10 s terminal grace) | We have the deterministic `handoff` tool; terminal state comes from the runner, not message-stream guessing. |
| Fork naming (`research-0429183`) | We have stable runIds. |
| Auto-destroy workers / no resumability | Our receipts, git checkpoints and `resumeFrom` are load-bearing (R2/R3/R6 stay). |
| `fork_status` activity replay via journal | Our feed ring + transcript capture already provide this; `delegate_status` reads them (R14). |

---

## 2. Goals and non-goals

### Goals

1. `delegate({background:true})` returns immediately; the parent turn continues (R8).
2. Up to `maxBackgroundRuns` children run **concurrently**, separate from the
   foreground one-child queue (R9).
3. Terminal results are delivered as session messages that wake an idle parent and
   steer a busy one, with at-least-once semantics and dedup after restart (R10–R12).
4. Ownership and delivery are branch-scoped and survive session restart/reload
   without double-delivery (R11–R13).
5. Parent→child steering, child→parent blocking questions with parent answers,
   and child→parent non-blocking notes (R16–R18).
6. Full auditability: every channel event is reconstructable from the session
   JSONL + receipts (pi-session-forensics stays true).

### Non-goals (first versions)

- No daemon, no pi-fleet, no cross-parent durability (Phase 3 is explicitly
  deferred and has entry criteria, §13).
- No child access to parent history.
- No automatic model-visible progress reports beyond child-initiated notes
  (open question OQ-1).
- No nested delegation (unchanged: `PI_DELEGATE_CHILD=1` keeps the extension inert
  except its child-mode tools; background children get `ask_parent` but no
  `delegate`).
- No workspace isolation — concurrent writes remain the caller's responsibility
  (unchanged from foreground; background makes it *more* likely, see §8).

---

## 3. Architecture

```text
PARENT PI PROCESS                                          CHILD PI PROCESSES (N ≤ maxBackgroundRuns)
┌────────────────────────────────────────────┐             ┌──────────────────────────────┐
│ delegate tool ──▶ application.runBackground │──spawn────▶│ pi --mode rpc --session-dir  │
│                      │                      │             │ PI_DELEGATE_CHILD=1          │
│              DelegateRunner (unawaited)     │             │ PI_DELEGATE_BACKGROUND=1     │
│                      │                      │             │ tools: <role>,handoff,       │
│              BackgroundManager ◀──onTerminal│             │        ask_parent            │
│   #generation guard · promise-tail delivery │             │                              │
│        │                                   │             │  ask_parent(question)        │
│        │ sendMessage(steer,triggerTurn)     │◀─stdout──── │   execute() blocks, polling  │
│        ▼                                   │             │   <runDir>/answers/<id>.json │
│  delegate-background-result / -question /   │             │              ▲               │
│  -note  custom messages                     │             │  toolResult = answer ◀─┐     │
│        │                                   │             └───────────┼───────────┼───┘
│  delegate_answer(runId,answer) ─────────────┼── write answer file ────┘           │
│  delegate_send(runId,message) ──────────────┼── stdin {type:"follow_up"} (steer)  │
│                                             │             (while child streaming)  │
│ session JSONL: delegate.background entries  │                                       │
│ (created/finished) + delivered messages     │                                       │
└────────────────────────────────────────────┘                                       │
```

New/changed modules:

- **`background.ts`** (new) — `BackgroundManager`: slot accounting, generation
  guard, tree pause/resume, terminal delivery (promise-tail serialized),
  reconcile/projection, ask routing, steer routing. No storage logic (uses
  run-store + session entries), no UI.
- **`application.ts`** — new `runBackground(request, hooks): Promise<{runId}>`
  beside `run()`: same `OpenedRun` flow, no `activeRun` reservation, no queue.
  `getStatus()` gains background inventory + pending questions.
- **`runner.ts`** — (a) completion callback hooks (`onTerminal`) — no behavioral
  change for foreground; (b) Phase 2: `steer(message)`, `writeAnswer(...)`,
  ask-in-flight watchdog exemption; (c) spawn env gains
  `PI_DELEGATE_BACKGROUND=1`, `PI_DELEGATE_ASK_DIR=<runDir>/answers` for
  background runs.
- **`ask.ts`** (new, Phase 2) — child-side `ask_parent` tool: params, validation,
  count cap, timeout, answer-file polling; parent-side answer envelope builder.
- **`index.ts`** — new tools (`delegate_status`, `delegate_send`, `delegate_answer`),
  `background`/`description` params on `delegate`, message renderers, child-mode
  `ask_parent` registration, lifecycle wiring (`session_start`, `session_before_tree`,
  `session_tree`, `session_shutdown`).
- **`config.ts`** — `maxBackgroundRuns`, `askParent{enabled,timeoutMs,maxPerRun}`
  (+ project overlay rules, + dashboard Advanced section).
- **`mode.ts`** — strict-mode active set extended (§10).

---

## 4. Requirements (normative)

### Phase 1 — background execution

**R8 — Background execution.** `delegate` gains optional `background: boolean`
(default `false`) and `description: string` (REQUIRED when `background: true`).
`description` follows pi-async-fork's rule: trimmed outer whitespace, 3–6
whitespace-separated words, single line, reject C0/C1 controls and U+2028/U+2029;
validated BEFORE any side effect. With `background: true`, the tool MUST resolve as
soon as the child is spawned and its receipt opened — content is the runId, role,
description, and one usage line ("poll delegate_status; the terminal report arrives
as a message; do not wait inline"). All existing request fields (role, timeout,
model, resumeFrom) keep their semantics. Per-run `timeout` still governs the
child (idle/stuck/hard watchdogs unchanged). The run's receipt records
`background: true` and `description`.

**R9 — Configurable background concurrency.** New config `maxBackgroundRuns`
(default **3**; dashboard-editable; project overlay applies). Background slots are
INDEPENDENT of the foreground queue and the one-child policy: the parent may run
1 foreground + N background children simultaneously. A background request when all
slots are taken MUST fail fast with `E_BACKGROUND_FULL` ("N background runs
active; wait for terminal reports or check delegate_status") — background calls
are never queued (the caller is not blocked, so fail-fast is the informative
outcome). Role preflight (research/Firecrawl) applies unchanged at spawn.

**R10 — Terminal result delivery.** When a background run reaches a terminal
state, the manager MUST (in order): finalize the receipt (existing path), append
the `finished` ledger entry (R11), then deliver ONE `delegate-background-result`
custom message with `deliverAs: "steer"` and `triggerTurn: true`. Content uses the
exact envelope in §5. Deliveries MUST be serialized through a promise tail (one
in flight). `triggerTurn: true` means: idle parent → wake into a turn; busy
parent → queue as steering (absorbed after the current turn's tool results).
Multiple staggered completions MAY produce multiple wake turns — the envelope
text is the mitigation (parent told to treat reports as internal work events).

**R11 — Session ledger & branch-scoped ownership.** The parent session JSONL is
the source of truth for background-run ownership. Append via `pi.appendEntry`
under custom type `delegate.background`, schema v1:

```jsonc
{ "v": 1, "type": "created",  "runId": "…", "role": "…", "description": "…", "createdAt": "ISO8601" }
{ "v": 1, "type": "finished", "runId": "…", "state": "succeeded|failed|cancelled|timed_out_idle|timed_out_hard|crashed", "finishedAt": "ISO8601" }
```

`created` is appended after successful spawn, BEFORE the tool result returns.
`finished` is appended BEFORE the result message is sent (replayable terminal
output — mirrors pi-async-fork's `fork.destroyed` ordering). Projection
(`project(getBranch())` root-to-tip) rebuilds the inventory on `session_start` and
`session_tree`; runs are owned by the branch that created them. Unknown/malformed
entries are skipped with diagnostics, never fatal. The run store remains the
detailed record; the session entry is the ownership + delivery-replay pointer.
On conflict, the session wins (established forensics rule).

**R12 — At-least-once delivery, dedup, restart reconcile.** `pi.sendMessage()` has
no delivery ack (documented pi-async-fork finding; applies equally to us). Every
delivered `delegate-background-result` message carries
`details: { runId, role, state, kind: "result" }`. On reconcile (session_start /
reload / tree change), for each projected run with a `finished` entry but NO
matching delivered message on the branch (scan `custom_message` entries with
`customType === "delegate-background-result"` and equal `details.runId`), the
manager MUST re-send the result exactly once more. Non-terminal background entries
whose receipt PID is dead (parent restart kills in-process children) MUST be
finalized orphan (existing PID-liveness-aware `markOrphansOnStartup` path), given a
`finished` entry, and delivered as an interrupted-result message with the
`resumeFrom` hint. Non-terminal entries whose receipt PID is ALIVE belong to
another concurrent pi session: the manager MUST NOT touch them; `delegate_status`
reports them as "owned by another live session (pid N)".

**R13 — Generation guard & branch pause.** BackgroundManager keeps a monotonically
increasing generation counter. Every callback (terminal, ask, steer ack, timers)
MUST validate the current generation and the run's registration before touching
session state or delivering. `session_before_tree` pauses delivery (terminal
outcomes buffer; nothing is delivered while a tree switch is in flight);
`session_tree` bumps the generation, re-projects, and resumes. `session_shutdown`
cancels background children (receipt finalizes `cancelled`; children are children
of the process and die with it — receipts must never be left non-terminal).
`session_start` bumps the generation and reconciles. A stale callback MUST never
deliver into a replaced session or a different branch.

**R14 — Status surface.** New model tool `delegate_status({ runId?, limit? })`:
without `runId`, lists background runs (slots used/free, per-run state, elapsed,
model, in-flight tool, pending ask if any) + queue depth; with `runId`, returns
one run's detail plus the bounded recent activity tail (from the existing feed
ring live, or `feedEventsFromTranscript` post-mortem; `limit` caps entries).
Terminal runs return the handoff summary + resume hint. `/delegate status` prints
the same inventory (panel ≡ command ≡ headless, unchanged principle).

**R15 — TUI.** `pi.registerMessageRenderer` for each new custom message type
(§5): neutral glyph+word cards — `✓ background <runId> · <desc>: completed`,
`⚠ …: failed` / `⏱ …: timed out`, `? …: asks`, `ℹ …: note`. Collapsed = header
line only; expanded = markdown body (the model-only envelope sentence is stripped
from display). Model-visible content never depends on the renderer. The dashboard
home gains a **Background runs** section (live rows: state · elapsed · in-flight ·
feed tail; pending-question rows expose the Answer… action, R19) and the footer
status shows `delegate ▸1 ▴2bg ?1ask`. `/delegate peek <runId>` works for
background runs unchanged (they are ordinary runs).

### Phase 2 — bidirectional channels

**R16 — Steering channel (parent → child).** New model tool
`delegate_send({ runId, message })`: routes to the owning runner which writes one
`{ "id": "delegate:<runId>:steer:<n>", "type": "follow_up", "message": … }` record
to the live child's stdin. The runner MUST only steer while the child stream is
active; steering is absorbed by the child at its next model call (pi steering
semantics — no interruption). If the run is terminal, the tool fails with an
instructive error pointing at `resumeFrom`. Steering a foreground run is
REJECTED (the foreground parent turn is blocked on it — the message could never
be consumed meaningfully mid-tool-call; resume is the mechanism there).
Steering increments the runner's idle-watchdog activity (a steer that lands while
the child is between turns must not trip inactivity before the child reacts).

**R17 — Question channel (child → parent, blocking).** Background children (and
ONLY background children — foreground ask_parent deadlocks by construction because
the parent's turn is blocked on the delegate tool call; see §8) get an
`ask_parent` tool in their ceiling:

```jsonc
ask_parent({ kind: "question", topic: "blocked|guidance|approval|opinion",
             question: string /* ≤ 2000 chars, single line preferred */ })
```

Child-side `execute()` resolves ONLY when the parent's answer file appears at
`$PI_DELEGATE_ASK_DIR/<toolCallId>.json` (poll ≤ 500 ms) or the ask times out
(`askParent.timeoutMs`, default 10 min): on timeout the tool returns the exact
fallback text "No answer arrived within the budget. Proceed with your best
judgment and state the assumption in your handoff." — the child is never wedged.
At most `askParent.maxPerRun` (default 5) question-calls per run; the (N+1)-th
returns a tool error instructing the child to proceed with assumptions.

Parent side: the runner sees the `ask_parent` toolCall record on the child
stream, (a) suspends idle/stuck watchdogs for that run while the ask is open
(the hard cap still applies — an ask never extends the run's absolute budget),
(b) delivers a `delegate-child-question` message (`deliverAs: "steer"`,
`triggerTurn: true` — a blocked child is material) with the envelope in §5, and
(c) registers the pending ask (runId + toolCallId). The parent model answers with
the `delegate_answer({ runId, answer })` tool; the extension routes it to the
runner, which writes the answer file `{ "answeredBy": "model"|"user",
"answeredAt": ISO, "answer": string }`. The child's tool result is
`[parent answered]\n<answer>`; the question, the answer tool call, and the tool
result are all ordinary session JSONL entries — the full round-trip is auditable
with the standard toolCall↔toolResult join. `delegate_answer` with an unknown
runId, or a run with no pending ask, fails with an instructive error. If the
child dies while its ask is pending, the ask is withdrawn at run finalization
(pending asks are cleared; late answers get the "run already finished" error).
Multiple children may ask concurrently: each question is its own message; if
several are queued the parent wakes once and answers each in one turn.

**R18 — Note channel (child → parent, non-blocking).** `ask_parent({ kind:
"note", topic: "risk|observation|concern", note: string })` in background
children: returns immediately on the child side (never blocks, never counts
against `maxPerRun` questions — it does count against a separate note cap of 20
to bound spam). The runner delivers a `delegate-child-note` message with
`triggerTurn: false` — notes NEVER wake an idle parent; they join the next turn's
context or sit until one happens (exactly pi-async-fork's progress semantics).
The envelope states no answer is expected. Notes are display+context only; they
do not create ledger entries beyond the delivered message itself.

**R19 — User intercept.** Because question messages are visible custom messages,
the user can always answer instead of (or before) the model: `/delegate answer
<runId> <text…>` command + dashboard Answer… action (text input; `answeredBy:
"user"`). Pending questions are listed in `/delegate status` and the dashboard.
This is the escalation path when the model's answer is wrong or the user wants
control — the mechanism is identical to R17, only the entry point differs.

**R20 — User-facing background launch.** `/delegate bg [general|research] <task>`
(the role prefix is optional and defaults to `general`) launches a background
run from the user surface. The command MUST use the same validation/spawn/
register path as the model tool's `background: true` request — role preflight,
request validation, `E_BACKGROUND_FULL` slot accounting (R9), `runBackground`,
and manager registration — it is an entry point, never a second implementation.
The user supplies no `description`, so one is DERIVED from the task's first
line: control characters act as separators, edge punctuation (leading/trailing
non-alphanumerics) is stripped from each word, and the first 3–6 words joined
by single spaces become the description. The derived value MUST pass the exact
R8 `description` validation before any side effect, MUST be echoed in the
started output (`[delegate background started · runId · role · description]`
plus the do-not-wait usage line), and MUST be stored on the receipt and the
`created` ledger entry exactly like an explicit description. A first line too
short to yield 3 words after cleaning MUST fail with an instructive error
(longer task, or an explicit `description` via the `delegate` tool) — the
command never launches with a degenerate description. Slot limits (R9) and all
delivery/ledger/reconcile semantics (R10–R13) apply unchanged. The dashboard
offers the equivalent **Run background task…** editor action feeding the same
path (panel ≡ command ≡ headless parity), and a background launch NEVER blocks
the invoking turn — the command resolves as soon as the child is spawned and
registered, exactly as the tool call does.


**R22 — Execution mode is a classification, not a category (default: background).**
Role (general/research) and execution mode (background/foreground) are ORTHOGONAL:
mode is configured state, never a third kind of run. New config key
`defaultExecution: "background" | "foreground"` (default **background**; project
overlay applies; dashboard Advanced screen exposes it as a toggle row). The
`delegate` tool's `background?: boolean` parameter changes meaning: ABSENT =
follow the configured default; `true`/`false` are explicit overrides. The
3–6-word `description` (R8 validation, R20 derivation for slash/panel launches)
is REQUIRED for EVERY delegation, foreground included — uniform receipts and
headers; foreground returns it inline in the result header. Slash surface:
`/delegate run [general|research] <task>` follows the configured default;
`--background` / `--foreground` flags override per-run (resume too);
`/delegate bg` remains the explicit background shorthand and `/delegate fg
<task>` joins as the foreground exception path. The dashboard offers exactly
TWO role-based run actions honoring the effective mode — the "Run background
task…" action is REMOVED; per-run foreground is reachable via the flag or the
Advanced toggle only (user decision 2026-09-10). Foreground semantics (one-child
queue, E_DELEGATE_BUSY, live feed) are unchanged but become the EXCEPTION lane;
model guidance flips: background by default, foreground only when the next step
depends on the result. Pre-existing e2e scenarios that test foreground behavior
pass `--foreground` explicitly, which makes their intent truthful.

**R21 — Rendered-view presentation (export + TUI).** Custom-message content is
read by TWO audiences: the model (raw content, verbatim) and rendered views
(pi's HTML export renders `display: true` custom messages as markdown in a
themed panel — extension renderers do NOT run there). Therefore every envelope
(R10 result, R17 question, R18 note) MUST be markdown-native: the header line
is a level-3 markdown heading; the model-only classification paragraph is
wrapped in a single-line HTML comment (`<!-- … -->`) so rendered views hide it
while the model context keeps it verbatim; the report body keeps its existing
`##` section structure. The TUI display (`backgroundResultDisplay` and the
question/note renderers) MUST show the short runId (last 12 chars) with the
full runId remaining in message `details`; glyph+word state discipline (UX
standard) is unchanged. Envelope snapshot tests are updated to the new bytes;
dedup scans (R12) match on `details.runId` and are unaffected.
---

## 5. Exact message envelopes (normative text)

All three types use `display: true` and details as specified. The first line is
the display header; the classification paragraph is model-facing and is stripped
by the renderer (R15).

**`delegate-background-result`** (`triggerTurn: true`):

```text
[delegate background <runId> · <role> · <description>: <state-word>]

This is the terminal report of a background delegation. The run has finished and
cannot receive steering. Treat it as an internal work event: write user-visible
text only if material, and do not re-narrate the handoff.

<formatRunText(res) — the same deterministic rendering as the foreground result,
 including partialHandoff, transcript path, and the resumeFrom hint on
 non-succeeded states>
```
details: `{ runId, role, state, description, kind: "result" }`

**`delegate-child-question`** (`triggerTurn: true`):

```text
[delegate background <runId> · <role> · <description>: asks]

A delegated child is blocked waiting for your answer (topic: <topic>). Answer
with the delegate_answer tool: delegate_answer({ runId: "<runId>", answer: "…" }).
Be terse and directive; the child resumes the moment your answer lands. Do not
narrate this exchange to the user unless it is material. If you cannot answer,
say so — the child proceeds with its best judgment after the ask budget expires.

<question text>
```
details: `{ runId, toolCallId, role, description, topic, kind: "question" }`

**`delegate-child-note`** (`triggerTurn: false`):

```text
[delegate background <runId> · <role> · <description>: note]

A delegated child filed a non-blocking note (topic: <topic>). No answer is
expected or possible. Treat it as an internal work event.

<note text>
```
details: `{ runId, role, description, topic, kind: "note" }`

---

## 6. Configuration

User-wide `~/.pi/agent/delegate/config.json` (project overlay
`<project>/.pi/delegate/config.json` follows the existing field-merge rules; the
dashboard Advanced section edits `maxBackgroundRuns` via the generic
`patchConfig`):

```jsonc
{
  "maxBackgroundRuns": 3,        // ≥1, ≤8; default 3; fail-fast beyond (R9)
  "askParent": {                  // Phase 2
    "enabled": true,              // false ⇒ ask_parent is not registered in children
    "timeoutMs": 600000,          // per-ask budget; MUST be < hard timeout to be meaningful
    "maxPerRun": 5                // question cap per run
  }
}
```

Validation: out-of-range values clamp to bounds with a doctor warning (existing
pattern), never fail session startup. Unknown keys keep the existing
unknown-keys diagnostic behavior.

---

## 7. Model contract (tool descriptions & promptGuidelines deltas)

- `delegate` description gains: "With `background: true` the call returns a runId
  immediately and the terminal report arrives later as a message — use it for
  long builds, test matrices, and research that should not block the turn. Pass a
  3–6-word `description`. Poll with `delegate_status`."
- promptGuidelines additions (foreground guidance unchanged):
  - Use background for long-running or fan-out work; stay foreground when the
    next step depends on the result.
  - Treat background reports/questions as internal work events; answer questions
    with `delegate_answer` promptly and tersely; acknowledge completions to the
    user with at most one line.
  - Do not re-issue a background task on `E_BACKGROUND_FULL` — check
    `delegate_status` and wait for terminal reports.
  - Prefer `delegate_send` for course corrections on live runs; use `resumeFrom`
    only after a run finished.
- Child task wrapper (`buildPromptMessage`, background variant) gains the
  ask contract: ask only when blocked or when a wrong guess is expensive;
  proceed with stated assumptions for cheap decisions; note risks via
  `ask_parent(kind:"note")` instead of stopping; the ask budget and fallback.

---

## 8. Safety analysis

| Risk | Analysis / mitigation (normative) |
|---|---|
| Foreground ask deadlock | `ask_parent` exists ONLY in background children (env-gated). A foreground child asking would deadlock the parent turn on itself by construction. MUST be enforced at tool registration, not prompt. |
| Child wedged on unanswered ask | ask timeout returns the proceed-with-assumption fallback (R17); idle/stuck watchdogs suspend while the ask is open so the wait itself cannot kill the child; hard cap still bounds the run. |
| Chatty children / context bloat | `maxPerRun` questions, 20 notes, ≤2000-char payloads, terse-answer envelope, and the child-side ask contract (§7). Notes are non-waking so they cannot create turn storms. |
| Wake storms | Only terminals and questions wake (both are bounded per run: 1 terminal, ≤5 asks). Notes never wake. Multiple completions may produce multiple turns — accepted (same trade pi-async-fork documents), mitigated by envelope discipline. |
| Answer quality gates throughput | Accepted by design (that is what makes children a team). Every answer is auditable; the user can intercept (R19). |
| Lost messages across crash | `finished` entry persists before delivery; reconcile re-sends undelivered results exactly once (R12). pi.sendMessage has no ack — same at-least-once + dedup stance as pi-async-fork. |
| Stale delivery into replaced session/branch | Generation guard + tree pause (R13), mirroring `controller.ts`. |
| Concurrent writes (N children + parent in one worktree) | Unchanged exposure, higher likelihood. Receipts already record `gitBase`/`gitDelta` per run (R6); docs must state coordination responsibility (§7 non-goal). |
| Run-store retention vs ledger | `maxRuns` may purge a receipt whose session entry still exists. Projection MUST tolerate a missing receipt (entry alone ⇒ "receipt purged; session JSONL is the record") — never crash reconcile. |
| Multi-session same worktree | Receipt PID liveness distinguishes "my dead run" from "another live session's run" (R12); never adopt or destroy another session's run. |
| Headless (`pi -p`) | Background works during the run, but process exit kills children; asks arriving after the final turn cannot wake anything and will time out in the child. `doctor` reports this; docs recommend foreground in one-shot headless flows. |

---

## 9. Restart / lifecycle semantics (state machine)

```text
session_start   → bump generation → project ledger → reconcile (R12) → attach live runs' streams
session_before_tree → pause delivery (buffer terminals)
session_tree    → bump generation → re-project → resume → deliver buffered
session_shutdown → cancel background children → finalize receipts (cancelled) → no ledger writes after shutdown
child terminal  → finalize receipt → append finished → deliver result (serialized)
parent crash    → children die → next session_start: PID-dead ⇒ orphan-finalize + interrupted-result delivery (once)
```

## 10. Strict coordinator mode interaction

Strict mode's active tool set becomes
`["delegate", "delegate_status", "delegate_send", "delegate_answer"]` — status,
steering, and answering are coordination acts, not substantive work, and omitting
them would break background runs in strict sessions. `mode.ts` MUST be updated in
the same phase as the tool registrations (a strict session that cannot answer its
children is a deadlock farm). Mode replay of older sessions without background
entries is unaffected.

## 11. Testing & validation matrix

**Unit** (`tests/`, fake `pi` object — the pi-async-fork testing style):
`background-manager.test.ts` (slots/E_BACKGROUND_FULL, generation guard, tree
pause, serialized delivery, reconcile+dedup idempotence, missing-receipt
tolerance), `ledger` projection & malformed-entry skipping, envelope text
snapshots (§5 exact strings), `ask.test.ts` (answer-file round-trip, timeout
fallback text, per-run caps, note cap, watchdog suspension flag), config
clamping, strict-mode set.

**E2E** (real pi, local oMLX model, existing harness; new scenarios):
(a) fan-out 2 background runs → both terminal messages delivered, parent wakes;
(b) kill/restart parent session → reconcile delivers exactly once (no dupes);
(c) ask_parent round-trip within one live session (question message, answer tool,
child tool result, child continues); (d) ask timeout fallback path;
(e) branch switch mid-run → no delivery on the wrong branch, delivery on return;
(f) strict mode + background + answer tools; (g) `delegate_send` steering lands
in child context; (h) E_BACKGROUND_FULL fail-fast.
Evidence under `.planning/async-background-*/evidence/` with `manifest.json`
(deterministic renderer output primary; live-terminal shots secondary; gaps
recorded as `knownGaps`, per the established capture rules).

**Forensics check:** every scenario must be reconstructable from the session
JSONL alone (toolCall↔toolResult join over `delegate_answer`, custom-message
details, `delegate.background` entries).

## 12. Milestones & versioning

| Milestone | Content | Version |
|---|---|---|
| M1 | R8–R13 core mechanism (background manager, ledger, delivery, reconcile) | — |
| M2 | R14–R15 surfaces (delegate_status, renderers, dashboard) + docs | **0.5.0** |
| M3 | R16 steering | — |
| M4 | R17–R18 ask/note channels + strict-mode set update | **0.6.0** |
| M5 | R19 user intercept + dashboard Answer… + polish | (0.6.x) |
| M6 | R20 user-facing background launch (`/delegate bg` + dashboard action, derived description) — post-goal amendment, user request | **0.6.2** |

Every milestone leaves `npm test` green (unit + e2e). Publish flow per AGENTS.md
(tests → `npm version` → commit/push → `npm publish` → `pi install npm:@maheidem/pi-delegate`
→ `/reload`; verify the agent-global store version line).

## 13. Open questions & deferred work

- **OQ-1** — Automatic model-visible progress (phase-change milestones,
  `triggerTurn: false`): deferred; notes (R18) cover the child-initiated need.
  Revisit if users ask for live intermediate evidence in parent context.
- **OQ-2** — Phase 3 detached runner ("pi-fleet-lite", loop-extension runner
  pattern) for parent-exit durability: deferred. Entry criteria: a real workflow
  needs children to outlive the parent session AND `resumeFrom`-based recovery
  proves too lossy in practice. If triggered, the file-based answer channel and
  the session ledger survive unchanged by design.
- **OQ-3** — Background calls queueing instead of fail-fast: decided fail-fast
  (R9). Revisit only if model behavior shows repeated harmful re-issues.
- **OQ-4** — Should `description` also be allowed on foreground runs (TUI header
  benefit only)? Leaning no (unused surface); decide at M2 UX review.

## 14. References

- pi-async-fork: README + SPECIFICATION.md (behavioral contracts), `src/forks/
  {controller,delivery,ledger,agent,session}.ts` (generation guard, promise-tail
  delivery, `project(getBranch())`, `isDelivered` dedup). Cloned 2026-09-09.
- pi 0.85.1 extension API: `docs/extensions.md` — `pi.sendMessage(message,
  {deliverAs, triggerTurn})` ("If agent is idle, trigger an LLM response
  immediately"), `pi.appendEntry`, `pi.registerMessageRenderer`,
  `ctx.sessionManager.getBranch()`, `session_before_tree`/`session_tree` lifecycle.
- Local prior art: `custom-extensions/delegate/.planning/delegate-p1-p2-p3-2026-09-02.md`
  (PID-liveness orphan recovery — load-bearing for R12), `custom-extensions/loop`
  (external runner pattern + RPC `follow_up` semantics — basis of R16 and OQ-2),
  `skills/pi-session-forensics` (audit-layer rules R11/R12 must preserve).
