# Peer review — REPORT.md (pi-delegate delegation-death investigation, 2026-09-03)

- **Review date:** 2026-09-03 (runs at 13:46Z, 15:14Z, integration ~15:40Z)
- **Reviewers:** independent delegate child sessions (Qwen3.8-27B@adaptive, local-mac) + the
  report author's adversarial pass. Full provenance in §1 below — including the fact that
  both reviewer runs died on hard timeouts and their verified findings were recovered from
  their transcripts.
- **Verdict:** **APPROVED WITH CORRECTIONS → APPROVED.** All corrections (§3) were applied to
  REPORT.md before this file was finalized; §2's checks re-run clean against the final text.

## 1. Provenance (read first)

1. **Reviewer run 1** — `del_20260903T134609Z` (13:46Z, 72 turns / 69,837 out-tok / 1 h):
   verified code claims C7 and re-derived C1–C6 numbers; died on `timed_out_hard` before
   writing this file. Its verification work is reproducible via `evidence/verify-claims.py`
   (the run's checks were distilled into it) and its transcript remains on disk.
2. **Reviewer run 2** — `del_20260903T151455Z` (15:14Z, 17 turns / 62,199 out-tok / 45 m,
   batched commands): completed spot-checks (jq/awk re-derivations, the "why" Q&A mapping,
   `onUpdate` precision, R3 feasibility against `docs/rpc.md` + `loop/runner.mjs`, the #54
   inspection-handoff cross-check, the #56/#57/#58 repair windows, store version/mtime) and
   produced the **key refinement (F1)**; died on `timed_out_hard` in the final verification
   step before writing this file. Its outputs are quoted in §2/§3 from its transcript.
3. **Author adversarial pass** (this file's §2d, §3, §4): re-verification of F1, the
   0-true-positives sweep for all five idle runs, window reconciliation, 0.1.0 config-default
   git check, and the R1–R8 feasibility analysis.

Both reviewer deaths are themselves a live instance of the report's RC2 (no partial handoff,
no resume) and are recorded as finding F6. Nothing in this review rests on an unexecuted
claim: every check below was run, and its command/output is cited.

## 2. Verification results

### 2a. Reproducible verifier
`evidence/verify-claims.py` — **36/36 checks pass** (re-run at 15:3xZ against the final
report text). Covers: 58/47/11 + failure mix; cost/wall/token impact; the bounded
12:30:48→13:04:05Z absorption window (28/30,119/119,677) with 0 delegate calls in-window and
≥1 after (14:54:10Z audit); the three silence gaps (300/300/300/2640/1350 s — see 2c); the
provider-error signatures; class-C receipts (#57/#58 model/turns/tokens/exit); parent
model-change @11:14:28.904Z; model usage 56×codex + 2×flash; session head ts; npm publish
times; the two "unknown failure" result texts; transcript capture formats (rawBase64 vs raw);
and the seven code-location claims (C7a–g).

### 2b. Independent re-derivations (different code paths than the verifier)
| Item | Method | Found | Matches report? |
|---|---|---|---|
| 58/47/11 + mix | jq over parent session (run 2) | 58 calls, 47 succeeded, mix 5 idle / 4 hard / 1 failed / 1 cancelled | ✅ |
| 2640 s gap, 230801 | awk epoch math on `receivedAt` (run 2) | 2640 s max gap, inside one bash tool call | ✅ |
| "why" Q&A (12:45Z user / 12:48Z assistant, session lines 353–354) vs §1 mapping | read (run 2 + author) | the three stated reasons map 1:1 to report items 1–3; no distortion/strawman; reason 1's parenthetical ("missing model Qwen3.8-27B") quoted verbatim from the parent | ✅ |
| Repair window after #56 | jq, 11:14:11→11:24:19 (run 2) | 11 calls / 4,092 out-tok | ✅ (report §6 updated to this window) |
| Absorption 12:30:48→13:04:05 | jq (run 2) + python (verifier) | 28 / 30,119 / 119,677 | ✅ |
| #54 inspection handoff (the 03:17 child's `finalHandoff`) vs §4 #53 row | read receipt (run 2) | S1 done, S2 failed (settle timeout), S3 pending, 445-line trace, harness serialization bug — all as reported | ✅ |
| Store copy version/mtime | `grep version` + `stat` (run 2) | 0.1.5 @ 2026-09-03 02:31:45 | ✅ |
| `onUpdate` precision (d) | read `runner.ts` `pushUpdate`/`cancel` + `index.ts` hooks (author) | during a run the TUI receives throttled live updates (`[delegate runId · role · phase · Ns]`) and the TUI running panel; the **final** result for a non-succeeded state is `handoff: ""` + `lastActions` (≤5 one-liners) + usage + transcript/stderr paths. The report claims "no partial handoff / no resumable session / no worktree checkpoint" **of the final result** — that is exactly what the code does; it does not deny live in-run signals | ✅ (no overclaim) |
| R3 feasibility (e) | `docs/rpc.md` + `loop/runner.mjs` (run 2, re-confirmed by author) | `follow_up` RPC command documented (rpc.md §follow_up, delivered when the agent finishes); `--session-dir` documented; **live precedent**: this repo's `custom-extensions/loop/runner.mjs` spawns `pi --mode rpc --session <file>` and injects `prompt` (idle) / `follow_up` (busy) — exactly the resume mechanism R3 needs | ✅ feasible |

### 2c. The 0-true-positives sweep (adversarial: try to break "all 5 idle kills were
false positives")
For each of the five idle runs, the largest inter-record gap was recomputed **and** its
enclosing tool call identified (gap start … matching `tool_execution_end` for the same
`toolCallId`):

| run | gap | inside one in-flight bash? | tool `end` result |
|---|---|---|---|
| 174738 (#7) | 300 s | ✅ `node run-v2-validation.mjs` (oMLX quality harness) | `"Command aborted"` |
| 175428 (#8) | 300 s | ✅ same ablation-harness dir, harness re-run | `"Command aborted"` |
| 180159 (#10) | 300 s | ✅ same dir, harness with resume/heartbeat changes | `"Command aborted"` |
| 230801 (#34) | 2640 s | ✅ 10×10 scenario matrix bash | `"Command aborted"` |
| 004607 (#43) | 1350 s | ✅ llama.cpp R-5 benchmark bash | `"Command aborted"` |

Every gap equals the then-effective inactivity value (5 m default ×3 — 0.1.0-era defaults,
git-confirmed at 83e4353: 300_000/1_800_000; 44 m user config ×1; hard/2 = 22.5 m cap ×1),
and every "end" record is an **abort artifact** (`"Command aborted"`), i.e. the tool was
killed mid-run. **No run shows a child that was genuinely stuck (zero bytes while no tool
was open). 0 true positives / 5 fires holds.** No counterexample found.

## 3. Corrections (all applied to REPORT.md)

- **F1 (reviewer run 2, verified by author): Class B was overbroad.** The empty
  `stop=error` messages in #34/#43 carry `errorMessage: "This operation was aborted"` and an
  abort `response` — they are artifacts of the extensions' **own watchdog abort**, not
  provider failures. The genuine provider failure is #56 alone, whose final `message_end`
  carries **`errorMessage: "Codex error: The usage limit has been reached"`** (no abort
  response in that transcript; the child settled on its own). Applied: §1 Class B row, §4
  rows #34/#43/#56, RC3, R4 (now keyed on reading the `errorMessage` field and
  classifying abort-artifact strings), and the "why" mapping (the parent's *remedy* —
  falling back to local — was operationally right since codex was usage-limited; its
  *reasoning* was wrong).
- **F2 (author): #34/#43 "tool completed 0–2 s before the kill" was wrong** — the
  `tool_execution_end` records in both transcripts read `"Command aborted"`; the long tool
  calls were aborted mid-run, not completed. Applied: §1 Class A row, §4 rows.
- **F3 (run 2): repair-window boundary** — the report's "12 calls / 5,329 out-tok" after
  #56 used an unbounded start (03:40:59); the clean window 11:14:11→11:24:19Z gives
  11 / 4,092. Applied: §6 table.
- **F4 (author, during re-verification): version timeline** — the report originally said the
  parent "loaded 0.1.3 at 17:18"; npm timing shows 0.1.1 published 18:17Z, i.e. **after**
  session start (17:18:47Z) → the session loaded **0.1.0**, with ≥1 reload in the window
  (19:58Z, 23:08Z] (evidence: `timeout` param accepted from #36; transcript format flip
  rawBase64→raw) and no reload after the 0.1.5 install (evidence: "unknown failure" texts at
  11:24Z/12:10Z). Applied: §1 Class D row, §3 timeline, RC5, §2 method.
- **F5 (author): live-session snapshot** — the parent session kept evolving (it delegated
  again at 14:54:10Z — an independent pre-release audit); all counts are now snapshot-bound
  to 13:04:05Z with the post-resume continuation reported separately (§3, §6, §6.1).
- **F6 (both reviewer runs): the review process itself hit RC2** — two delegate children died
  on hard timeouts (1 h / 45 m) with no partial handoff; 135k+ output tokens of verification
  work survived only in transcripts. Recorded in §1 provenance and report §6.1. This is the
  strongest possible validation of the report's central claim (a dead child costs its entire
  context), and it motivates R2/R3 as the immediate next builds.
- **F7 (author): 0.1.0 config defaults git-confirmed** — 83e4353 (v0.1.0) carries
  inactivity 300_000 / hard 1_800_000, identical to current, so the early-run "5 m/30 m
  built-in defaults" explanation is exact, not inferred.
- **F8 (author): store at retention cap** — `~/.pi/agent/delegate/runs` holds exactly 50
  receipts (= `maxRuns`); the next startup sweep purges the oldest terminal receipts, which
  will include receipts cited in this investigation's Appendix B. Recommend raising
  `maxRuns` (or archiving the 11 cited receipts + transcripts) as a one-line config follow-up.

## 4. Recommendation review (R1–R8)

| R | Implementation risk (checked) | Missing detail / note | Impact |
|---|---|---|---|
| R1 in-flight tool = activity | Low. Killed tools **do** emit `tool_execution_end "Command aborted"` (verified in 174738/175428/180159/230801/004607 — the child processes the RPC abort within ~5 ms of the SIGTERM path starting). Residual: if SIGKILL lands before the child reacts, no end record — the existing `finalizeOnExit` already finalizes on child exit, so an "open tool at exit" state is covered. `tool_execution_update` events (seen in 230801) already extend the watchdog today; R1 closes the long-silent stretches. | Add a separate `stuckToolTimeoutMs` (default = hardMs) so a truly hung tool is still reaped; don't let "tool open" be an infinite pass. | 5 |
| R2 graceful timeout handoff | Medium. A child **mid-bash cannot answer** until the tool ends: RPC `follow_up` is delivered "when the agent finishes" (rpc.md), and a `prompt` mid-stream is not the right tool. Correct sequence: `abort` (ends the in-flight tool, as today) → wait for `agent_settled` → send the handoff `prompt` → wait `handoffGraceMs` (90 s default is sane: a short local-model answer took ~10–60 s in the runs observed; codex answers were ~2–10 s) → SIGTERM fallback. | The handoff prompt must forbid new tool calls (answer from context only) or the child could re-enter a long tool and re-trigger the timeout; include "files changed so far" in the prompt (the child knows its own edits). | 4 |
| R3 durable child session + resume | Low–medium. **Feasibility proven**: `follow_up`/`prompt` RPC + `--session <file>` is exactly what `custom-extensions/loop/runner.mjs` does live in this repo (spawns `pi --mode rpc --session <file>`, idle→`prompt`, busy→`follow_up`, auto-cancels `extension_ui_request`). Risk: session schema drift across pi versions (resume is best-effort — document it) and session-file growth (5–6 MB per 45-min run; retention already cleans run dirs). | Reuse the loop extension's RPC-client gotchas (auto-cancel UI requests; measure liveness by message count, not leaf id); the resume prompt should carry `partialHandoff` (R2) + the failure state. | 4 |
| R4 provider-error diagnosis | Low. The `errorMessage` field is verified present in final `message_end` records (033911: "Codex error: The usage limit has been reached"; killed runs: "This operation was aborted" / "Request was aborted"). | Normalize the abort-artifact strings into a `killed_by_watchdog` classification (this de-masks #34/#43-style signatures); quote the verbatim error for everything else (`E_PROVIDER_ERROR`). | 3 |
| R5 model pinning + echo | Low. `--model` is already passed to the child (`buildChildArgs`); a `model` param only needs plumbing into `buildRequest` (the `modelString(ctx)` resolution pattern exists at index.ts:186). | Echo the resolved child model in the running update **and** result header; warn on child≠parent model at spawn (the 11:14 cascade). | 3 |
| R6 worktree checkpoint | Low. `cwd` is always a pi project (usually git); capture HEAD + `status --porcelain` pre-run, `diff --stat` post-run. | Cap `gitDelta` bytes in the receipt (a big refactor's diff can exceed the display budget); skip gracefully for non-git cwds. | 3 |
| R7 version + provenance in results | Trivial. | Show loaded version + timeout sources (user/project/per-run); document `/reload` semantics in the README. | 2 |
| R8 timeout-semantics docs | None (docs). | Ship alongside R1 so the "hard/2 cap" story is explained until R1 lands. | 2 |

Suggested build order: **R4 + R7 (trivial, stop the misdiagnosis and staleness blindness) →
R1 (kill 45% of observed failures) → R2 → R3 → R5/R6**. e2e scenarios G/H/I from the report
plus one new: **J** (R4: force a provider error in a mocked/stubbed child, assert the
`errorMessage` text appears verbatim in the result and the abort-artifact string classifies
as killed-by-watchdog).

## 5. Additional findings

1. **The "stop delegating" was bounded, not permanent.** The parent resumed delegation at
   14:54:10Z for an independent pre-release audit (read-only, no provider calls) — exactly
   the "isolated, high-token job" it promised in its 12:48Z answer. The failure-rate fix
   (R1–R4) should restore delegation for the long-work class; the report's §6 postscript
   says this.
2. **Abort artifacts are a diagnostic trap.** Two of the five "provider-empty-error"
   signatures in this session were self-inflicted (F1/F2). Any future triage of
   `stop=error` + empty content must check `errorMessage` **and** the presence of an abort
   `response` before blaming the provider. R4 encodes this.
3. **Transcript capture format is version-dependent** (rawBase64 pre-0.1.2, UTF-8 `raw`
   post-d270dcd). Tooling over `~/.pi/agent/delegate/runs` must handle both (the verifier
   does); a future schema version should bump `schemaVersion` explicitly rather than
   swapping key names.
4. **Evidence retention is now a live concern** (F8): 50/50 receipts stored; the 11 receipts
   + 6+ MB transcripts cited by this report are not safe from the next sweep. One-line fix:
   `maxRuns` up (e.g. 500) or archive the investigation's receipts into this `.planning/`
   directory.
5. **Nothing in the store contradicts the report.** The two curation events (P1 clobber race
   on #12; retention purge of 9 receipts at 03:40:59Z) are documented in receipt
   `curationNote`s and are accounted for in §3/§5 of the report; no receipt-level claim in
   the report survives only in a clobbered receipt — each is corroborated by the parent
   session's tool results (the durable layer).

## 6. Verdict rationale

Every load-bearing number re-derives (36/36, plus two independent re-derivation pipelines).
The failure taxonomy survives the adversarial pass (0/5 true-positives holds; Class B refined
to one genuine provider failure with its error text recovered from the stream). The
recommendations are feasible against the real pi RPC surface (R3 proven by live precedent in
this repo) with the implementation risks identified above. Corrections F1–F8 were applied and
the final text re-verified. **APPROVED.**
