# pi-delegate — Investigation: why the Context-Management-v1 session abandoned delegation

- **Date:** 2026-09-03
- **Report snapshot:** 2026-09-03T13:04:05Z (the goal-resume message in the parent session; that session is
  live and kept evolving — see §6 postscript)
- **Status:** final (peer-reviewed — see `REVIEW.md`; every load-bearing number is re-derivable
  via `evidence/verify-claims.py`, 36/36 checks)
- **Author:** pi session `01a06750` (forensic analysis via `pi-session-forensics` method)
- **Scope:** the 58 `delegate` calls made by session `01a06321` (the "Context Management v1"
  implementation-owner session, active 2026-09-02T17:18Z → 2026-09-03T13:04Z+), the 11 failed
  runs among them, and the `@maheidem/pi-delegate` extension behavior (v0.1.0–0.1.5) that
  produced them.
- **Deliverable:** root-cause report + ranked, code-anchored improvement proposals for the
  extension.

## 1. Executive summary

The implementation-owner session delegated 58 times over ~19 hours: **47 succeeded (81%),
11 failed (19%)** — 5× `timed_out_idle`, 4× `timed_out_hard`, 1× `failed` (`E_CHILD_MODEL`),
1× `cancelled`. The last four attempts (`#53, #56, #57, #58`) all failed, and the parent
therefore finished the remaining cross-file refactor inline and stopped delegating.

Ground truth from the run transcripts, receipts, and the parent's own session JSONL shows the
failures are **five distinct mechanisms**, not one:

| Class | Runs | Mechanism (verified) | Share of failures |
|---|---|---|---|
| **A — inactivity-watchdog false positive** | #7 #8 #10 #34 #43 | Child was mid-way through a *single long tool call* (oMLX validation harnesses ×3, 10×10 scenario matrix, llama.cpp R-5 benchmark — all verified: the 300 s / 300 s / 300 s / 2640 s / 1350 s silence gaps each lie inside one in-flight bash, and each `tool_execution_end` reads `"Command aborted"` — the tool was **killed mid-run**, not completed). pi's RPC stream emits no bytes while a tool runs, so the watchdog (5 m default → 44 m → capped at hard/2 = 22.5 m) fired. True positives in this session: **0/5**. | 5/11 (45%) |
| **B — provider usage-limit failure, misreported** | #56 (direct) | `gpt-5.6-sol` via `openai-codex` returned `message_end` with `stopReason: "error"` and the payload **`errorMessage: "Codex error: The usage limit has been reached"`** — present in the child's stream, but the extension reported `E_CHILD_MODEL` quoting an **unrelated stderr tail** (a harmless `model-discovery` notice about `Qwen3.8-27B` on `mac-m3`) and never read the `errorMessage` field. The parent **misdiagnosed** this as a model-registration bug. (The similar empty-error signatures in #34/#43 are **not** provider events — they are abort artifacts of the Class A kills, see below.) | 1/11 |
| **C — hard timeout shorter than the work** | #12 #53 #57 #58 | 30 m default hard vs. multi-hour validation (#12); parent-imposed 45 m vs. a 5-session local soak (#53, honest progress — S1 done, S2 failed, S3 pending); parent-imposed 45 m + 20 m vs. a ~1600-line cross-file refactor **assigned to a 2.7B-class local flash model the child silently inherited** after the parent's 11:14Z model switch (#57: 62 turns / 50,826 out-tok, still in read/plan phase at kill; #58: 24 turns / 20,112 out-tok, killed mid-planning). | 4/11 (36%) |
| **D — deployment lag (aggravating, session-level)** | all timeouts | The parent process's delegate code **lagged every shipped fix**: the session started 17:18:47Z on **0.1.0** (0.1.1 published 18:17Z — after the start), was reloaded at least once in the window (19:58Z, 23:08Z] (evidence: `timeout` param accepted from #36 at 23:55Z → ≥0.1.3; transcript capture format flipped `rawBase64`→`raw` → ≥0.1.2), and was **never reloaded after the 0.1.5 install (05:31Z)** — the two final calls still rendered pre-0.1.5 `error: unknown failure`. So **no run ever executed 0.1.5's P1/P3 fixes**; early runs also predate the per-run timeout feature and ran the 5 m/30 m built-in defaults; and the P1 clobber race plus the retention sweep (9 receipts deleted at 03:40:59Z) struck this session's store while it ran. | n/a (aggravator) |
| **E — user/parent cancel** | #14 | Parent aborted a re-delegation after 33 s (directional decision, not an extension fault). | 1/11 |

**Costs measured:** failed runs burned **$0.98 of $5.07 (19%)**, **231.8 of 512.4 min (45%)**
of child wall time, and **96,542 of 315,882 (31%)** of child output tokens. In the 24 minutes after the final
death (#58, 12:30:48Z → 13:04:05Z, the goal-resume message) the parent ran **28 tool calls /
30,119 out-tok / 119,677 in-tok with zero delegate calls** — the remaining refactor (writing
`commands.ts`, rewriting `application.ts`) ran serially in the parent's context window, which
is precisely the cost delegation exists to avoid. (Post-resume the session continued inline
and delegated again at 14:54:10Z — an independent pre-release audit, exactly the "isolated,
high-token job" it had promised to hand back.)

**Why the parent stopped (its three stated reasons, checked):**

1. *"The children kept dying … I had to inspect and repair the child's partial state."*
   **True as to consequence** (verified: after #57 the parent re-inspected and found
   config/state/transforms/reports + a cosmetic rename; after #58 it continued from that
   state), **misattributed as to cause** (the `E_CHILD_MODEL` death was a codex **usage-limit**
   failure — `"Codex error: The usage limit has been reached"`, present in the child's stream —
   not the "missing model Qwen3.8-27B" registration issue the stderr tail implied; the
   parent's *remedy* — falling back to local — was operationally right, its *reasoning* wrong).
2. *"This task is cross-file atomic."* **Legitimate task-shape factor.** A 5-file type
   signature change is a bad fit for a child that can be killed at 80% with no checkpoint,
   no partial handoff, and no resume. Mitigable (R2/R3/R6 below), not fixable by the parent
   choosing differently.
3. *"The context is already loaded here; a child starts cold."* **Structurally true with the
   current design:** children run `--no-session` (no durable child session → no resume path),
   so after any death the only option is cold re-explanation of the module graph.

The design gap in one sentence: **when a child dies, the extension returns a dead state with
no partial handoff, no resumable session, and no worktree checkpoint — converting every
timeout into a full re-explanation + repair cycle.**

## 2. Method and evidence base

- **Parent session (ground truth):**
  `~/.pi/agent/sessions/--Users-maheidem-Documents-dev-pi-coder-management--/2026-09-02T17-18-47-672Z_01a06321-6378-7065-b902-6d454b543fc5.jsonl`
  (993 KB, still active). All 58 delegate `toolCall`↔`toolResult` pairs joined via
  `toolCall.id == toolResult.toolCallId`; per-call args (task/role/timeout), result
  `details` (state, runId, durationMs, model, usage, displayItems), and the literal result
  text the parent saw are in `evidence/delegate-calls-full.json`.
- **Run store (receipts + transcripts + stderr):** `~/.pi/agent/delegate/runs/` —
  58 receipts for this session (incl. receipts reconstructed by the 2026-09-03 curation,
  each carrying a `curationNote`).
- **Child transcripts (RPC stream captures):** `<runId>.jsonl` — raw records
  (`{schemaVersion, sequence, receivedAt, stream, raw}`); used for silence-gap analysis and
  for reconstructing the child's final state at each kill.
- **Extension source:** `custom-extensions/delegate/` (0.1.5 @ `8e8d196`) + npm publish
  timestamps (`npm view @maheidem/pi-delegate time`) + git version-bump history.
- **Prior art:** `.planning/delegate-p1-p2-p3-2026-09-02.md` (P1 orphan clobber, P2 base
  timeouts, P3 error payloads — fixed in 0.1.5) and the curated ground-truth JSON. This
  report does not re-derive those; it covers what *still* failed after them.

Methodology follows the `pi-session-forensics` skill: the session JSONL is authoritative;
on-disk receipts are a cache (and this session's store suffered both known clobber/retention
events, so every receipt-level claim was re-checked against the tool results). One capture
nuance: pre-0.1.2 transcripts store payloads as `rawBase64` (0.1.2/d270dcd switched to UTF-8
`raw` text); all base64-era records were decoded, not skipped. The parent session is **live**;
every count is snapshot-bound to 2026-09-03T13:04:05Z (goal-resume message), and the
post-resume continuation is reported separately (§3, §6, §6.1).

## 3. Timeline (what actually happened)

All times UTC (Z) — the session/receipt/npm timestamps are Z; local is UTC−3. The *code version*
row is what the parent **process** was executing (loaded at session start, changed only by
`/reload`), not what a fresh pi process would load.

| When (Z) | Event |
|---|---|
| Sep 2 11:02 | 0.1.0 published |
| **Sep 2 17:18:47** | **Parent session `01a06321` starts → loads 0.1.0** (5 m inactivity / 30 m hard built-in defaults; `rawBase64` transcript capture; no per-run timeout param) |
| 17:19–18:08 | Runs #1–#10 (gpt-5.6-sol). #7/#8/#10 die `timed_out_idle` at ~6 min: **5 m default inactivity** vs. long oMLX validation tool calls (Class A, first appearances; #7's victim verified as `node run-v2-validation.mjs`, killed mid-run) |
| 18:17 / 18:26 / 19:58 | 0.1.1 / 0.1.2 (transcript `raw` text) / 0.1.3 (per-run `timeout`) published |
| 18:18–18:51 | #12 dies `timed_out_hard` at the **30 m default** mid-validation; its receipt is clobbered in an **8 ms race** (P1 bug — the clobbering pi startup ran 0.1.1, pre-P1); #14 cancelled by parent at 33 s |
| between 19:58 and 23:08 | **Parent `/reload`** (at least once): from #36 (23:55) onward the `timeout` param is accepted and transcripts use `raw` text → the process now runs ≥0.1.3 code |
| 20:43 | 0.1.4 published (dashboard timeouts) |
| 23:08–03:40 | #34 (10×10 scenario matrix) silent for **44 m** inside one bash → watchdog abort kills it mid-run (23:53:58); #43 (00:46, llama.cpp R-5 benchmark) silent for **22.5 m** (= hard/2 cap of the then-45 m project hard) → same abort at the watchdog boundary. The empty `stop=error` messages in both transcripts are **abort artifacts** (`"This operation was aborted"`), not provider failures |
| Sep 3 05:31 | **0.1.5 published + installed** (P1+P3 fixes) — into the npm store only; the parent process is never reloaded after this |
| 03:40:59 | Retention sweep (`maxRuns: 50`; the clobbering pi startup ran 0.1.4, pre-P1) deletes the 9 oldest receipts (documented in `curationNote` on the 023212 receipt) |
| 03:39–03:41 | #56 (big refactor, gpt-5.6-sol, `timeout: 2h`) dies in 108 s: **codex empty-error response** → `E_CHILD_MODEL` with misleading stderr tail. The parent session's own model (same codex model) then hits the wall → **goal paused, "usage-limited"** |
| ~06:57 | Curation event (other session): 9 receipts reconstructed + 8 corrected from parent tool results |
| **11:14** | User: "carry on". **Parent switches its own model → `mac-m3/qwen3.8-flash@adaptive`** (codex exhausted). Goal resumes 11:17. **Every child from here on silently inherits local flash** (no `model` param exists in the tool schema) |
| 11:19–11:24 | Parent inspects the tree, finds #56's partial work (cosmetic rename + `application.ts` 1606 lines), rewrites the module-boundary test, re-delegates the full refactor to the (inherited) flash model, `timeout: 45m` |
| **11:24→12:09** | **#57: 45 m hard timeout.** Flash child: 62 turns, 50,826 out-tok, 4.8 M cacheRead — created `config.ts`/`state.ts`/`transforms.ts`/`reports.ts` but was killed mid read/plan turn (`stop: aborted` after the runner's RPC abort → 2 s → SIGTERM, exit 143). Parent saw: `error: unknown failure` — 0.1.5 (with P3's specific error text) had been published + installed at 05:31Z, but this process was never reloaded, so the fix was inactive here |
| 12:09→12:10 | Parent re-inspects (3 calls / 1.4 m), writes the "Slice A" re-delegation describing the partial state, `timeout: 20m` |
| **12:10→12:30** | **#58: 20 m hard timeout.** Flash child: 24 turns, 20,112 out-tok, killed mid-planning ("Now I'll write a node script that does line-based structural edits…"). Parent saw: `error: unknown failure` |
| 12:45 | User: "why did you decide to not use delegation anymore?" → the answer quoted in the goal |
| 12:45→13:04:05 | **Parent does the rest inline** (28 tool calls / 30,119 out-tok, zero delegates): writes `commands.ts` 17.2 KB, rewrites `application.ts` to 325 lines of thin orchestration, edits transforms/config. Tree at snapshot: 7 modules / 2051 lines |
| 13:04→14:54 | Post-resume the session continues inline (more calls), then at 14:54:10 **delegates again** — an independent pre-release audit of `pi-thinking-saver` v0.1.1 (read-only, no provider calls) — the "isolated, high-token job" it had promised |

## 4. Failure analysis (per-run ground truth)

Full per-call table: `evidence/delegate-calls-full.json`. Key rows:

| # | runId (short) | state | dur | evidence of what was true |
|---|---|---|---|---|
| 7 | `174738` | timed_out_idle | 6.7 m | 300 s (5 m default) silence = one in-flight bash: `node run-v2-validation.mjs` (oMLX quality harness); kill → `tool_execution_end: "Command aborted"`. (Transcript is 0.1.0-era `rawBase64` capture — decoded, not guessed.) |
| 8 | `175428` | timed_out_idle | 6.0 m | task was *itself* "inspect + continue after timed-out #7" — the re-delegation also died idle |
| 10 | `180159` | timed_out_idle | 6.3 m | task: add deterministic resume + heartbeats to the harness (i.e. the parent was already trying to patch Class A around, per-run) |
| 12 | `181850` | timed_out_hard | 30.0 m | 30 m **default** hard vs. multi-hour validation; receipt clobber race 18:48:52.857 (clobber) vs .863 (true write) → mixed state, later corrected |
| 14 | `185052` | cancelled | 0.5 m | parent abort after 33 s |
| 34 | `230801` | timed_out_idle | 46.0 m | **2640 s silence = one bash tool call** (the 10×10 matrix); watchdog abort at 23:53:58 → `tool_execution_end: "Command aborted"` + empty `stop=error "This operation was aborted"` message — **both are abort artifacts of the kill, not a provider failure**; the 44 m harness run was aborted mid-run |
| 43 | `004607` | timed_out_idle | 24.3 m | **1350 s silence = 22.5 m = hard/2 cap** (45 m project hard); llama.cpp R-5 benchmark bash; same abort-artifact signature (killed mid-run at the watchdog boundary) |
| 53 | `023212` | timed_out_hard | 45.0 m | parent-imposed 45 m vs. 5-session local soak; inspection child (03:17) found: S1 done, S2 failed (settle timeout), S3 pending, S4–S5 not started; harness serialization bug; 445-line raw trace valid |
| 56 | `033911` | failed | 1.8 m | codex `stop=error` after 15 turns of active editing; the final `message_end` carries **`errorMessage: "Codex error: The usage limit has been reached"`** (in the stream, unread by the extension); stderr file contained **only** the two `model-discovery` lines → the "missing model Qwen3.8-27B" in `errorMessage` is unrelated noise; child settled on its own (no abort sent — `response {command: abort}` absent) |
| 57 | `112419` | timed_out_hard | 45.0 m | flash child, 62 turns / 50,826 out-tok; final turn = thinking "Now I have everything. Also need the … texts. Let me dump the root handler region (1470-1560)" — still reading/planning; `response {command: "abort", success: true}` → `agent_settled` → SIGTERM 2 s later, exit 143; created 4 module files |
| 58 | `121046` | timed_out_hard | 20.0 m | flash child, 24 turns / 20,112 out-tok; final turn = thinking "Now I'll write a node script that does line-based structural edits…" — planning the very next edit; same kill sequence |

Silence-gap method: largest inter-record gaps in each transcript's `receivedAt` series.
#7/#8/#10: 300 s; #34: 2640 s; #43: 1350 s — each gap is exactly the then-effective
inactivity value, and each gap lies *inside a single tool call* (one `tool_execution_*`
start … end pair with no intervening records).

## 5. Root causes (code-anchored)

**RC1 — The inactivity watchdog measures stream bytes, and a running tool call is silent.**
`runner.ts` `armInactivity()` is reset by *any* stdout/stderr chunk (`onStdout`/`onStderr` →
`noteActivity`). pi's RPC host emits `tool_execution_start` and then nothing while the tool
runs (at most an occasional `tool_execution_update`). Meanwhile `config.ts:204-210`
(`resolveRunTimeouts`) caps inactivity at **hard/2** ("a long-silent child can never outlive
its watchdog" — the stated design intent). Consequence: **any single tool call longer than
`min(inactivityConfig, hard/2)` is guaranteed to be killed**, and that is exactly the work
class delegation is used for (test matrices, provider benchmarks, soaks). 5/5 watchdog fires
in this session were false positives; 0 true positives.

**RC2 — The kill path discards everything the child knows.**
`cancel()` (runner.ts): RPC `abort` → 2 s → SIGTERM → 5 s grace → SIGKILL. The child has
~2 s after the abort before SIGTERM — no time to produce a final summary. `outcome()` returns
`handoff: ""` for every non-`succeeded` state; the receipt gets only `lastActions` (last 5
tool one-liners), usage, and a transcript path. Compounding: children run with **`--no-session`**
(`buildChildArgs`), so there is **no durable child session to resume** — after any death the
only option is a fresh child + re-explained task. And nothing records the worktree baseline
(HEAD/dirty state) before the run, so "what did the child change" requires re-reading the
tree. This is the direct cost source of the parent's "I had to inspect and repair the
child's partial state anyway."

**RC3 — `E_CHILD_MODEL` diagnostics point at the wrong thing.**
`finalizeSettled()`: `stopReason === "error"` → `failed` with
`"Child model stopped with an error (stderr tail: …)"`. The stderr tail is read from the
child's stderr file (`stderrTail()`), which in the one genuine provider failure (#56)
contained only unrelated `model-discovery` notices from the *user's* `mac-m3` config. The
actual error was sitting in the stream: the final assistant `message_end` carries an
**`errorMessage` field** (`"Codex error: The usage limit has been reached"` in #56; abort
artifacts in killed runs) — the extension never reads it. Observed consequence: the parent
concluded "the child model was configured to a model that's missing" (its 11:16Z thinking)
and switched its own model, cascading a weak model into all subsequent children.

**RC4 — The child silently inherits the parent's current model, and cannot be pinned.**
`buildChildArgs` passes `--model req.parentModel`; the tool schema (`index.ts:265-275`)
offers only `task`/`role`/`timeout` — **no `model` (and no `thinkingLevel`) parameter**.
When the parent switched to `qwen3.8-flash` at 11:14Z (a fallback because codex was
exhausted), runs #57/#58 silently inherited a 2.7B-class model for a ~1600-line cross-file
refactor. No warning, no echo beyond the receipt's `model` field, no way to override.

**RC5 — Deployment lag is invisible from inside a running session.**
Extensions load at session start; `/reload` is the only live update. The parent started on
0.1.0 at 17:18:47Z; was reloaded (at least once) between 19:58Z and 23:08Z (from #36 on,
`timeout` is accepted and transcripts use `raw` text → ≥0.1.3 code); and was **never reloaded
after the 0.1.5 install at 05:31Z** — its final calls at 11:24/12:10Z still rendered
`error: unknown failure` (the pre-P3 builder, `index.ts:58/241`). Consequences: no run ever
benefited from P1/P3; the early runs predate even the per-run timeout feature (5 m/30 m
built-in defaults); and the store-damage events (clobber race at 18:48:52Z by a 0.1.1
startup; retention purge at 03:40:59Z by a 0.1.4 startup) struck while this session ran. Nothing
in the tool result or status tells a running session *which version it is executing* or that a
newer store copy exists, so the "unknown failure" behavior was indistinguishable from
"0.1.5 is broken."

## 6. Quantified impact

| Metric | Value |
|---|---|
| delegate calls / success rate | 58 / 81.0% |
| Failure mix | 5 idle (45%) · 4 hard (36%) · 1 provider (9%) · 1 cancel (9%) |
| Watchdog precision in this session | **0 true positives / 5 fires** |
| Child wall time burned by failures | 231.8 / 512.4 min (45%) |
| Child output tokens burned by failures | 96,542 / 315,882 (31%) |
| USD burned by failures | $0.98 / $5.07 (19%) |
| Parent repair after #56 (provider death) | 11 calls / 4,092 out-tok in 11:14:11Z→11:24:19Z (~5 min active after an 8 h usage-limited pause) |
| Parent repair after #57 | 3 calls / 1,487 out-tok / 1.4 min (re-delegation prep) |
| Parent absorption 12:30:48Z→13:04:05Z (final death → goal resume) | **28 calls / 30,119 out-tok / 119,677 in-tok, 0 delegate calls** — the remaining refactor ran inline in the parent (post-resume it continued inline, then delegated again at 14:54:10Z) |
| Store damage during the session | 1 clobber race (#12, by a 0.1.1 startup) + 9 receipts deleted by retention sweep at 03:40:59Z (by a 0.1.4 startup) — both pre-P1 behaviors |

## 6.1 Postscript — this investigation dogfooded the failure mode

The independent peer-review children for this report (del_20260903T134609Z: 72 turns / 69,837
out-tok / 1 h; del_20260903T151455Z: 17 turns / 62,199 out-tok / 45 m) both died on
`timed_out_hard` with no partial handoff and no resumable session — 135k+ output tokens of
verification work surviving only in transcripts. The review was completed from their
transcript outputs plus a reproducible verifier + the author's adversarial pass; full
provenance is in `REVIEW.md` §1. Two children, two hard timeouts, zero partial handoffs —
RC2 in the field, during the investigation that documents it.

## 7. Recommendations (ranked; code-anchored)

**R1 — In-flight tool calls count as activity. (fixes RC1; kills 45% of observed failures; small)**
`runner.ts`: track open tool calls from `classifyRpcRecord` `tool_event` start/end pairs.
While ≥1 is open, the inactivity watchdog must not fire (or fires only after a separate
`stuckToolTimeoutMs`, default = `hardMs`, configurable). The watchdog should then only see
*truly* silent children. Unit test: `sleep 300` child under 60 s inactivity must survive; a
child that stalls with no open tool must still be reaped.

**R2 — Graceful timeout handoff. (mitigates RC2; high impact; medium)**
On `timed_out_hard`/`timed_out_idle`: before the SIGTERM, write a bounded final RPC prompt —
"You are being terminated. Reply with: (1) files changed and what each now does, (2) what
remains, (3) last verification state. Be concise." — wait `handoffGraceMs` (default 90 s,
configurable), capture the final assistant text as `partialHandoff` in the receipt **and**
the result text; SIGTERM as fallback. The parent then gets a map of the partial work instead
of five truncated one-liners; "inspect and repair the child's partial state" becomes "read
the handoff, verify two files."

**R3 — Durable child session + resume. (mitigates RC2; changes the cold-start math; medium)**
`buildChildArgs`: replace `--no-session` with a session file inside the run dir (e.g.
`<runId>.session.jsonl`), recorded in the receipt. New optional tool param `resumeFrom:
runId` (or `/delegate resume <runId>`): re-enter the child session via
`pi --mode rpc --session <file>` with a follow-up prompt carrying the `partialHandoff`/
failure context. After a timeout, continuing is **one prompt into the same context** instead
of a fresh child + re-explained module graph — directly answering the parent's reason #3.

**R4 — Precise provider-error diagnosis. (fixes RC3; small)**
`finalizeSettled()`: when `stopReason === "error"`, read the final assistant `message_end`'s
**`errorMessage` field** (verified present in the stream — #56: `"Codex error: The usage
limit has been reached"`; killed runs: `"This operation was aborted"` / `"Request was
aborted"`) and build the report from it: (a) abort-artifact strings → classify the run as
killed-by-watchdog (this also de-masks the #34/#43 signatures); (b) anything else → code
`E_PROVIDER_ERROR` with the verbatim `errorMessage`; (c) the stderr tail is never presented
as the cause (label it "unrelated stderr" or omit it). For #56 the parent would have read
"usage limit reached" instead of "missing model Qwen3.8-27B" — the misdiagnosis chain
(stderr noise → "registration bug") becomes impossible.

**R5 — Model pinning + echo. (fixes RC4; small)**
Add optional `model` to `DelegateParams` (schema currently `task`/`role`/`timeout` only);
resolve and **echo the child model in the running update and the result header**; warn at
spawn when the resolved child model differs from the parent's current model. Makes the
11:14Z cascade visible and preventable.

**R6 — Worktree checkpoint in the receipt. (mitigates RC2; small)**
When `cwd` is a git worktree: record pre-run `HEAD` + `git status --porcelain` at start and
a post-run `diff --stat` (vs. run start) at finalization (`gitBase`/`gitDelta` receipt
fields). Post-death inspection becomes one command (`git diff <gitBase>`) instead of a
re-read.

**R7 — Version + config provenance in every result. (fixes RC5; trivial)**
Include the loaded extension version (and timeout sources: user/project/per-run) in the
result header and `/delegate status`. A running session that sees `unknown failure` can then
cross-check release notes; "stale copy in this process" becomes self-evident. Also document
in the README that fixes require `/reload` in live sessions.

**R8 — Timeout-semantics guidance. (prevention; docs)**
Document: effective inactivity = `min(config, hard/2)` (`config.ts:204`); per-run `timeout`
raises the hard cap and (via the cap) the idle cap; a single tool call longer than the
effective inactivity is always killed (until R1 lands); for long validation/benchmark work
set `timeout` ≥ 2× the expected longest tool call.

Suggested verification (mirrors the P1–P3 e2e pattern in
`.planning/delegate-p1-p2-p3-2026-09-02.md`): e2e **G** (R1: child runs `sleep 300` with
inactivity 60 s — must not be idle-killed while the tool is open; a no-tool stall must still
reap), **H** (R2: force an 8 s hard timeout mid-bash — assert `partialHandoff` in receipt +
result text and clean reaping), **I** (R3: kill a run, then `resumeFrom` — the resumed child
must reference its earlier file edits without re-reading the repo).

## 8. Out of scope / not extension faults

- The P1 clobber, retention purge, and missing error payloads were **fixed in 0.1.5**; this
  session's exposure was because its process ran pre-0.1.5 code (RC5), and both store-damage
  events are documented in receipt `curationNote`s.
- #14 (`cancelled`) was a deliberate parent decision.
- The codex **usage-limit** failure (class B, #56) is an external provider limit; R4 improves
  triage of it (the error text was in the stream all along), and R3 makes its aftermath cheap,
  but the limit itself is not fixable here.
- The parent's *task-shape* judgment (reason #2) is sound for today's extension; R2/R3/R6
  change the trade-off but do not make cross-file-atomic work delegatable-by-default.

## 9. Appendices

- A: per-call ground truth — `evidence/delegate-calls-full.json` (58 rows: call ts, args,
  state, runId, durationMs, model, usage, error text as seen by the parent).
- A2: reproducible verification — `evidence/verify-claims.py` (36 checks; re-derives every
  load-bearing number from the parent session, receipts, transcripts, source and npm;
  snapshot-bound to 13:04:05Z).
- B: failure receipts — `~/.pi/agent/delegate/runs/del_20260902T174738Z_e79dc2f2.json`,
  `…T175428Z_32f1f033`, `…T180159Z_981629f2`, `…T181850Z_9da48e0b`, `…T185052Z_e3924d87`,
  `…T230801Z_7c3c4a70`, `…20260903T004607Z_1238b870`, `…T023212Z_623d2b0a`,
  `…T033911Z_ddb256a0`, `…T112419Z_6d2c6164`, `…T121046Z_58e6f979` (+ matching `.jsonl`
  transcripts and `.stderr.log`).
- C: code references — `runner.ts` (`armInactivity`/`onStdout`/`cancel`/`finalizeSettled`/
  `buildChildArgs`/`stderrTail`), `config.ts:204-210` (`resolveRunTimeouts`), `index.ts:58,241,
  265-275` (result builder + `DelegateParams`).
- D: version/publish timeline — git `83e4353…8e8d196`; npm `0.1.0` 2026-09-02T11:02Z …
  `0.1.5` 2026-09-03T05:31Z; store install mtime 2026-09-03 02:31:45 local.
- E: the parent's "why" exchange — parent session lines 353–354 (12:45–12:48Z).
