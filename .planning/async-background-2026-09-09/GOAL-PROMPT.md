# GOAL PROMPT — Delegate async/background + bidirectional channels (R8–R19) to shipped versions

> Hand this whole file to a fresh agent in a `/goal` session. It is self-contained.
> Work in `/Users/maheidem/Documents/dev/pi-coder-management/custom-extensions/delegate`.

## Definition of Ready (all must hold BEFORE you start — verify, don't assume)

- [ ] `SPEC.md` (next to this file) status line says **APPROVED**. If it still says DRAFT,
      stop and ask the user — do not start implementation on a draft spec.
- [ ] Repo state: `git -C . log --oneline -1` recorded in your first report; `package.json`
      version is the baseline noted in SPEC.md (0.3.2 at spec time — confirm).
- [ ] Local model server oMLX up (`http://127.0.0.1:8123`) — e2e needs it; `npm run doctor`
      or an e2e dry run proves it before you rely on it.
- [ ] `npm run typecheck && npm test` pass on the untouched tree (baseline green).

## 0. Your mission (one sentence)

Implement async/background delegation and bidirectional child channels in the
`@maheidem/pi-delegate` extension exactly per `.planning/async-background-2026-09-09/SPEC.md`
(requirements R8–R19, milestones M1–M5), every milestone gated by green tests and captured
evidence, foreground behavior fully preserved, shipped as **0.5.0** (after M2) and **0.6.0**
(after M4) through the repo's publish flow.

## 1. What this thing is (context you need)

`delegate` runs a bounded subtask in an isolated child Pi process (`pi --mode rpc
--session-dir …`, single prompt over RPC stdin, JSONL records on stdout), enforces a
mandatory structured `handoff` tool, and returns a bounded result with receipts, durable
resumable sessions, and git checkpoints. Today it is **foreground**: the tool call blocks;
parallel calls queue through a one-child FIFO (`application.run`). The extension loads in
children too (`PI_DELEGATE_CHILD=1`) where it registers only the `handoff` tool.

Read these **before touching code**, in this order:
1. **THE SPEC** — `.planning/async-background-2026-09-09/SPEC.md`. Normative. §4 requirements,
   §5 exact envelopes, §6 config, §8 safety table, §9 lifecycle, §11 test matrix. Build to this.
2. This file (decisions in §2 are closed).
3. Prior art at source level: `git clone --depth 1 https://github.com/elpapi42/pi-async-fork /tmp/pi-async-fork`
   → `src/forks/controller.ts` (generation guard, tree pause), `delivery.ts` (promise-tail
   serialized delivery, `triggerTurn` discipline), `ledger.ts` (`project(getBranch())`,
   `isDelivered` dedup). Adopt the patterns; NOT the pi-fleet dependency (SPEC §1).
4. Code map (this package): `index.ts` (registration + child mode + say helper),
   `application.ts` (`run`, queue, `activeRun` reservation — add `runBackground` beside it),
   `runner.ts` (`DelegateRunner`, `buildChildArgs` tool ceiling + env, watchdogs
   idle/stuck/hard, `settledResolver` completion), `run-store.ts` (receipts,
   `markOrphansOnStartup` **PID-liveness-aware — load-bearing for R12**), `handoff.ts`
   (child tool pattern to imitate for `ask_parent`), `mode.ts` (strict set), `transcript-feed.ts`,
   `ui/` (panel + cards), `tests/` (existing suite — keep green).
5. Pi docs (installed, absolute): `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
   → `pi.sendMessage(message, {deliverAs, triggerTurn})` ("If agent is idle, trigger an LLM
   response immediately" — THE async wake primitive), `pi.appendEntry`, `pi.registerMessageRenderer`,
   `ctx.sessionManager.getBranch()`, `session_before_tree`/`session_tree`.
6. Repo `AGENTS.md` — delegate section, publish flow, and the gotchas list (§8 below repeats
   the ones that bite hardest here).

## 2. Decisions already made — do not re-litigate

- **No pi-fleet, no daemon.** The existing `DelegateRunner` is the runtime; children are
  children of the parent pi process. Parent-exit durability = existing sessions +
  `resumeFrom` + PID-aware orphan finalization (SPEC OQ-2 keeps a detached runner deferred).
- **`maxBackgroundRuns` default 3** (config + dashboard-editable, clamp 1–8). Background
  slots are independent of the foreground one-child queue.
- **Background overflow fails fast** (`E_BACKGROUND_FULL`), never queues (OQ-3 closed).
- **`ask_parent` is background-ONLY** (env-gated). A foreground child asking deadlocks the
  parent turn by construction — enforce at tool registration, not prompt text.
- **Questions and terminal results wake** (`triggerTurn: true`); **notes never wake**
  (`triggerTurn: false`). Wake text carries the "internal work event" discipline (SPEC §5).
- **Answer channel = files**: `$PI_DELEGATE_ASK_DIR/<toolCallId>.json`, child polls ≤500 ms.
  No sockets. `askParent` defaults: enabled, `timeoutMs` 600000, `maxPerRun` 5; notes cap 20.
- **Ledger**: `delegate.background` custom entries (`created`/`finished` v1) in the session
  JSONL; `finished` appended BEFORE the result message is sent; dedup by scanning delivered
  `custom_message` details; session JSONL wins over receipts on conflict.
- **Strict mode set** becomes `["delegate","delegate_status","delegate_send","delegate_answer"]`
  in the same phase the tools register.
- **Foreground behavior must not change.** Every 0.3.x test stays green unmodified (additive
  phases only). `formatRunText` is reused verbatim inside the result envelope.
- Ship **0.5.0 after M2**, **0.6.0 after M4** (M5 may ride 0.6.x). `description` (3–6 words,
  async-fork validation) is required for background runs.

## 3. Concrete reuse mandate (do NOT recreate)

- Spawn/receipt/paths flow: reuse `application.run`'s `OpenedRun` internals via a new
  `runBackground` — no parallel store, no second run-id scheme.
- Completion: `DelegateRunner` already resolves a `RunnerOutcome`; background = await it
  without the tool's `AbortSignal`, plus an `onTerminal` hook. Watchdogs unchanged except
  the ask-in-flight suspension (SPEC R17).
- Delivery: copy pi-async-fork's `Delivery` promise-tail pattern (~30 lines) into
  `background.ts`; do not build a queue system.
- Envelopes: exact strings in SPEC §5 — snapshot-test them; do not paraphrase.
- UI: existing `renderToolResultCard` conventions for the new message renderer cards
  (glyph+word, never color-alone); dashboard rows via the vendored `SettingsPanel`
  vocabulary; peek works on background runs with zero changes.
- Feed: `FeedRing` / `feedEventsFromTranscript` for `delegate_status` activity tails.
- The `say()` helper for headless output (gotcha: `ctx.ui.notify` is a no-op in print mode).

## 4. Environment / facts (verified on this machine)

- The version Pi actually runs = the **agent-global store** copy:
  `grep '"version"' ~/.pi/agent/npm/node_modules/@maheidem/pi-delegate/package.json`.
  Never trust the project `node_modules` for this.
- Unit = `npm test`; typecheck = `npm run typecheck`; e2e = `npm run test:e2e`.
  **Model selection (user decision 2026-09-09): e2e runs with
  `DELEGATE_E2E_MODEL=zai/glm-5.3`** so the local oMLX stays free — the harness
  patches the isolated settings copy (`defaultProvider`/`defaultModel`, zai creds
  ride the `auth.json` copy). Without the env var e2e uses the live default
  (oMLX) — prefer the override for all goal e2e runs.
  `E2E_SCENARIOS=<letters>` selects a subset — existing letters A–K are
  taken; assign new letters for the SPEC §11 scenarios (a)–(h) continuing the sequence).
  The e2e harness strips the npm delegate package from its isolated settings copy so the
  source under test is the only loaded copy.
- Publish flow (AGENTS.md): `npm test` → `npm version <semver> --no-git-tag-version` →
  commit+push → `npm publish` (**2FA OTP must be typed by the user in a real terminal —
  you cannot automate it**) → `pi install npm:@maheidem/pi-delegate` → remind the user to
  `/reload`. Registry can lag ~30 s after publish → retry the install, don't republish.
- This workspace is **multi-session**: another pi session may edit these files between your
  turns. Re-read any file from disk before `edit`; reconcile, never silently revert.

## 5. Build order — gated milestones (never mix phases; report after each gate)

- **M1 — core mechanism (R8–R13).** `background.ts` (`BackgroundManager`: slots,
  generation guard, tree pause/resume, promise-tail delivery, reconcile/dedup),
  `application.runBackground`, `delegate` `background`+`description` params, ledger
  entries, restart/orphan reconcile (PID-aware). Unit tests: slots/E_BACKGROUND_FULL,
  guard, dedup idempotence, malformed-entry tolerance, envelope snapshots.
  **Gate:** `npm run typecheck && npm test` + e2e (a) fan-out and (b) restart-once.
- **M2 — surfaces (R14–R15).** `delegate_status` tool, `/delegate status` inventory,
  message renderers, dashboard Background section, footer. **Gate:** unit + e2e (a,b) +
  panel≡command≡headless parity test. **Ship 0.5.0** (publish flow; user does OTP).
- **M3 — steering (R16).** `delegate_send`, runner `steer()` (`follow_up` stdin record,
  streaming-only, terminal→resume hint), idle-watchdog interplay. **Gate:** e2e (g).
- **M4 — ask/note channels (R17–R18).** `ask.ts` (child tool: params, caps, timeout
  fallback text, answer-file polling), runner ask handling + watchdog suspension, parent
  `delegate_answer`, question/note messages, `askParent` config, strict-mode set update.
  **Gate:** unit (round-trip, timeout, caps) + e2e (c)(d)(f). **Ship 0.6.0.**
- **M5 — user intercept (R19).** `/delegate answer` + dashboard Answer… action + pending
  list. **Gate:** e2e (c via user path) + docs polish.

Run the gates after each milestone and report results with evidence pointers. If a gate
fails twice for the same cause, stop and surface it — do not push through.

## 6. Evidence — REQUIRED (under `.planning/async-background-2026-09-09/evidence/`)

- `manifest.json` mapping every claim → file → what it must show (pattern:
  `ui-redesign-2026-09-04/evidence/manifest.json`).
- **Deterministic renders** of the three message-renderer cards (all states, width 80/62)
  — primary evidence, no model needed.
- **E2E artifacts**: per scenario (a)–(h): the parent session JSONL path + the exact join
  proof (e.g. "`delegate_answer` toolCall↔toolResult joined; child toolResult contains the
  answer; `delegate.background` created/finished pair present; exactly one delivered
  `delegate-background-result` per run after restart").
- **Forensics check per milestone**: the scenario must be reconstructable from the session
  JSONL alone (tools + custom messages + entries). If it isn't, the design leaked state —
  fix before proceeding.
- Live TUI shots (tmux capture) for the dashboard Background section and question card —
  secondary; record shortfalls as `knownGaps` with attempt counts, don't retry forever.

## 7. Definition of Done (all must hold at each ship gate)

- [ ] typecheck 0 errors; **existing 0.3.x unit + e2e suite green unmodified**; new suite green.
- [ ] Spec §4 requirements for the shipped phase verifiably met (walk the list in your report).
- [ ] Envelope texts byte-match SPEC §5 (snapshot tests).
- [ ] No delivery without ledger entry; no dupe after restart (e2e (b) proves both).
- [ ] `ask_parent` absent from foreground children (negative test).
- [ ] Strict mode updated in the same phase as tool registration.
- [ ] README + `/delegate help` document background, status, send/answer; model-facing
      tool descriptions + `promptGuidelines` updated per SPEC §7.
- [ ] Evidence set complete with `manifest.json`; forensics check passed.
- [ ] Published (`0.5.0` / `0.6.0`), `pi install`ed, store version verified, user reminded
      to `/reload`.

## 8. Guardrails

- **Never publish without the user's go** after the milestone gate; the OTP step is the
  user's by construction.
- Do not patch Pi core `dist/`; documented extension hooks only.
- Any deviation from SPEC.md gets folded back into SPEC.md **in the same commit** — the
  spec is the review surface.
- Do not touch `loop`, `model-discovery`, or other extensions; this goal is delegate-only.
- Multi-session workspace: re-read files before editing; if you find unexplained changes,
  reconcile per AGENTS.md instead of overwriting.
- The run store purges old receipts (`maxRuns`) — reconcile must tolerate a purged receipt
  (SPEC §8 row); never let retention break startup.
