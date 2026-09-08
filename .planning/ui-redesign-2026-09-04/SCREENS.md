# Delegate UI — Visual Spec & User Journey

Companion to `PLAN.md`. Mockups are 80 columns; all screens also verified against 62 and 20 in
implementation (§ UX-STANDARD 8). Decisions applied: **D1 = both** (compact inline *during*
execution + richer detail inside `/delegate`), **D3 = Advanced tucked behind a screen**.

Legend · `▸` selected row · `›` opens secondary · `⚠` destructive (confirm) · colors via semantic
tokens only (never color alone — every state has words/glyphs too).

---

## 0. Screen map & user journey

```
                         pi launches
                              │
                              ▼
                    ┌──────────────────────┐
                    │   S1  HOME (idle)    │  bare `/delegate`
                    │  "is it working?"    │
                    └───────────┬──────────┘
        run general/research  │  g / r            doctor d · paths / · status (bare, headless)
        ┌─────────────────────┼──────────────────────────────┐
        ▼                     ▼                              ▼
 ┌────────────┐   ┌───────────────────────┐        (report text → stdout/transcript)
 │S3 EDITOR   │   │  S2  HOME (live)      │  panel refreshes 1s while a child runs
 │ task input │   │  compact live block   │
 └─────┬──────┘   └───────────┬───────────┘
       │ submit                │ (same run, two inline views, D1 "both")
       ▼                      ┌───────────────┴────────────────┐
 ┌───────────────┐           ▼                                ▼
 │S4 INLINE STRIP│  ┌──────────────────┐      ┌──────────────────────┐
 │ (slash path)  │  │ S5 INLINE tool    │      │  S6 PEEK (detail)     │
 │ composer strip│  │ call in transcript│      │  full scrolling feed  │
 └───────┬───────┘  │ (model path)      │      │  p / Peek ›           │
         │          └──────────────────┘      └──────────┬───────────┘
         │  esc×2 ⚠                                       │ q = back to HOME
         ▼                                                ▼
 ┌───────────────┐                              (returns to S1/S2 home)
 │ S8 CANCEL ⚠   │
 │ confirm scope │
 └───────┬───────┘
         │ confirm → run cancelled → home shows "last: cancelled · resume ›"
         ▼
   R resume → S3 EDITOR (continuation) → run again in same child session

  Configure advanced… › → S7 CONFIG screen (editable knobs) → q back to HOME
```

Every secondary screen returns to home (`q` = back), never dumps the user at a raw prompt.

---

## S1 · Home (idle) — the centralized window

Trigger: bare `/delegate` (TUI). Non-TUI prints `statusText()` instead.

```
╭─ Delegation ────────────────────────────────────────────────────────────────╮
│ ✓ ready · v0.3.0 · normal mode                                              │
│ active: none · queue: 0/3 · last: general · succeeded · 30m 22s          │
│                                                                            │
│ Actions                                                                    │
│  ▸ Run general ›              Run research ›                             │
│    Peek last run ›          Inspect last run ›                         │
│    Resume last run ›      ⚠ Cancel active run                        │
│    Enable strict mode       Doctor ›        Paths ›                    │
│                                                                            │
│ Timeouts (base)                                                          │
│    Hard · user-wide            2h                                        │
│    Hard · project              not set                                   │
│    Idle · user-wide            2h                                        │
│    Idle · project              not set                                   │
│    Stuck-tool · base           off         ← R1 in-flight watchdog     │
│                                                                            │
│ Configure advanced… ›                                                     │
│                                                                            │
│ changes save immediately              ↑/↓·j/k move · enter · q quit       │
╰────────────────────────────────────────────────────────────────────────────╯
```
- Row 1 = "is it working" (glyph `✓` **and** the word `ready`; `!`/`degraded` when not).
- Row 2 = "what is active" (active / queue depth / last). `Cancel`/`Peek`/`Resume` rows are
  `disabled` when nothing applies (greyed + explicit, not hidden — so the affordance is stable).
- `Configure advanced… ›` = the tuck (D3).
- ~15 rows: fits every laptop.

---

## S2 · Home (live) — same window, live block appears while a child runs

The run path keeps the user **in this window**; a `Live run` section (refresh 1s, cleared on
close) replaces the top when active. This is the Loop countdown idiom.

```
╭─ Delegation ────────────────────────────────────────────────────────────────╮
│ ● running · v0.3.0 · normal mode                                           │
│ active: del_…9daa (general · glm-5.3) · queue: 2/3                      │
│                                                                            │
│ Live run                                            refreshed 1s             │
│    general · glm-5.3 · turn 12 · ↑41k ↓6.2k                            │
│    ███████░░░░░░░░░░░░░░░░  41% of 45m hard                           │
│    in flight: bash `pnpm test`  (22s)                                 │
│    +22s ▶ bash pnpm test                                              │
│    +6s  ✓ read src/audio/engine.ts (2s)                            │
│                                                                            │
│ Actions                                                                    │
│    Peek live feed ›      ⚠ Cancel active run                        │
│    Doctor ›              Paths ›                                     │
│                                                                            │
│ Timeouts (base) …  Configure advanced… ›  (collapsed while running)      │
│                                                                            │
│ esc×2 cancel this run · q close panel              ↑/↓ j/k · enter · q     │
╰────────────────────────────────────────────────────────────────────────────╯
```
- Live block = newest events at the bottom, bounded; full history is in **Peek (S6)**.
- Fixed height: the config sections collapse to one line while running so the panel never grows.
- `q` closes the panel (run continues in the child; `/delegate peek` re-enters).

---

## S4 · Inline execution strip — slash path (what lives where you type)

Trigger: `/delegate run …` (or Run from panel). Mounts in the **composer region** as a
**fixed-height** strip — the 0.2.3 height/width contract so it never smears the input bar.

```
╭─ Delegating · general · glm-5.3 · 0m41s ────────────────────────────────────╮
│ ███████░░░░░░░░░░░░░░░░░░░░░  41% of 45m hard   turn 12   ↑41k ↓6.2k       │
│ ▶ in flight: bash `pnpm test` (22s)                                          │
│ +18s ✓ read engine.ts · +9s ✎ ## Outcome · +3s ▸ spawn test-runner         │
│ esc twice to cancel · q peek full view                                       │
╰──────────────────────────────────────────────────────────────────────────────╯
```
- **Exactly 6 rows, always** (blank-padded). Never changes height.
- `q` here drops into **Peek (S6)** for the detailed scrolling view (D1 "even more detailed"),
  `esc×2` cancels (confirm glyph `⚠` appears on first esc).

---

## S5 · Inline execution — model tool path (transcript rendering)

When the **model** calls the `delegate` tool there is no composer component — it renders as a tool
call in the transcript. Today that shows a bare `error:`/result block (the thing you flagged). Fix:
implement the tool's **`renderCall`** (live) + **`renderResult`** (final), driven by `onUpdate`
partialResult.

During execution (`renderCall` + partialResult):
```
  ⚙ delegate  ▸ general · glm-5.3 · 41% of 45m · in flight: bash `pnpm test` · turn 12
```
After completion (`renderResult`, succeeded — handoff front and centre):
```
  ✓ delegate  del_…9daa · general · glm-5.3 · 7m31s · done
      ▸ Outcome: matrix green; 3 files changed, tests 38/38
      ▸ Changes: audio/engine.ts, preload.ts, config.json
      ▸ Verification: pnpm test, pnpm build   ▸ Remaining: none
      peek: /delegate peek del_…9daa · resume: resumeFrom del_…9daa
```
On cancel (`renderResult`, neutral, NOT an error):
```
  ⊘ delegate  del_…9daa · cancelled at 6m02s · partial handoff captured
      resume: /delegate resume del_…9daa "<continuation>"
```
- Cancelled/timed-out render with distinct glyphs (`⊘`, `⏱`) + words — **not** `error:` unless a
  real failure (`E_*`).

---

## S6 · Peek — detailed scrolling feed (the "even more detailed" view)

Trigger: `Peek live feed ›` / `p`, or `/delegate peek [id]`. Post-mortem works too.

```
╭─ Peek · del_…9daa · general · glm-5.3 · running ────────────────────────────╮
│ ~/.pi/agent/delegate/runs/del_…9daa.jsonl                                   │
│ ● live · following · j/k scroll · f re-follow · q back · ↑40 ↓0          │
│ +04s ▶ spawn glm-5.3                                                      │
│ +07s ▶ read specs/lean-audit.md                                          │
│ +19s ✓ read specs/lean-audit.md (12s)                                   │
│ +41s ▶ bash pnpm test                                                   │
│ +63s ✓ bash all green (22s)                                             │
│ +70s ✎ ## Outcome — matrix green                                       │
│ +74s ▣ handoff submitted (done)                                         │
│ … 40 earlier events · j to scroll up                                    │
╰──────────────────────────────────────────────────────────────────────────╯
```
- Fixed 20-row viewport (already built), `q` → **back to home**, `f` re-follow, `j/k` scroll.
- headless (`pi -p '/delegate peek …'`): prints the last ~40 lines to stdout.

---

## S7 · Configure advanced — secondary settings screen (D3 tuck)

Trigger: `Configure advanced… ›`. Every knob is an editable `input` row → `app.patchConfig`
(generic), saved immediately with inline validation + confirmation echo.

```
╭─ Configure · advanced ────────────────────────────────────────────────────────╮
│ edits save immediately to ~/.pi/agent/delegate/config.json                  │
│                                                                            │
│    ▸ Queue limit              3      ← concurrent calls serialized        │
│      Kill grace             5s      ← SIGTERM→SIGKILL grace              │
│      Handoff enforce        60s     ← bounded mandatory-handoff wait     │
│      Handoff grace          90s                                          │
│      Update throttle        0.1s                                         │
│      Max result bytes       51200                                        │
│      Retention              50 runs / 30d  ← purges old run evidence     │
│                                                                            │
│ enter edit · esc back to home · q quit                        (retention ⚠)│
╰──────────────────────────────────────────────────────────────────────────╯
```
- Retention is the row that silently deletes evidence — annotated inline (surfaced because AGENTS
  flags it), and lowering it warns.

---

## S8 · Cancel confirm (destructive, §9)

Trigger: `⚠ Cancel active run` / `x` / `esc×2`.

```
╭─ Cancel run? ────────────────────────────────────────────────────────────────╮
│ Cancels del_…9daa (general · glm-5.3 · 6m02s).                            │
│ The child is stopped; a partial handoff is captured if it has one.        │
│ You can resume it later: /delegate resume del_…9daa "<task>"             │
│                                                                            │
│        ▸ Yes, cancel            No, keep running                          │
╰──────────────────────────────────────────────────────────────────────────╯
```

---

## S3 · Run editor (Pi-native) — unchanged surface

`Run general ›` → `ctx.ui.editor("Delegated task (general)", "")` → submit → S2/S4 live.
(Uses Pi's editor so multiline + focus/cursor are handled by the framework, per §5.)

---

## S9 · Reports (Inspect / Doctor / Paths) — text cards

Rendered to transcript (TUI) and stdout (headless), stable wording for humans + scripts (§7).

```
╭─ Doctor ─────────────────────────────────────────────────────────────────────╮
│ ✓ pi runtime · ✓ child session dir · ✓ config (valid)                     │
│ ! stuck-tool OFF (long tools can hang a run unwatched)   ← warning+word    │
│ ✓ oMLX reachable 127.0.0.1:8123 · ✓ handoff protocol v1                     │
│ ✓ retention 50/30d · ✓ no orphan runs                                       │
│ paths: config ~/.pi/agent/delegate/config.json · runs ~/.pi/…/runs/       │
╰──────────────────────────────────────────────────────────────────────────╯
```

---

## S10 · Headless (`pi -p`) — every action still works (§10)

| you run | stdout |
| --- | --- |
| `/delegate` | `statusText()` (version, mode, active, queue, last, timeouts) |
| `/delegate status` | same stable status block |
| `/delegate run general "<task>"` | runs; prints final `renderResult` text card |
| `/delegate peek <id>` | last ~40 feed lines |
| `/delegate cancel` | `cancelled del_…9daa` + receipt path |
| `/delegate doctor` | the S9 block, plain text |

No action is TUI-only. `notify` is bypassed in print mode (routes to stdout).

---

## S11 · Completion / help (nested grammar is first-class, §3)

```
/delegate ␘   run│peek│resume│cancel│inspect│status│doctor│paths│enable│disable│help
/delegate run ␘  general│research
/delegate <knob> ␘   30m│2h│1d  (time)   0…N  (counters)
```

---

## What changes vs today (mapping to PLAN.md slices)

| today | becomes | slice |
| --- | --- | --- |
| panel missing status/peek/cancel/resume + knobs | home + Configure carry them all; generic `patchConfig` | 1 |
| `running-view` bespoke inline | **stays as the compact inline strip (S4)**, but fixed-height conformant; live state ALSO mirrored in home Live block (S2) | 2 |
| model tool shows bare `error:`/result | tool `renderCall`/`renderResult` (S5), cancelled/timed-out rendered neutral+resume | 2 |
| `peek-view` bespoke overlay | S6, contract-conformant, `q`=back-to-home | 3 |
| partial completion | full nested grammar (S11) | 4 |
| delegate untracked by drift guard | added to `check-vendored.mjs` | 0 |

Note (revision to PLAN.md §Slice 2): D1="both" means we **keep** a compact inline execution strip
(we do NOT delete `running-view`) — we make it fixed-height/conformant and mirror its state in the
home Live block, and add `renderCall`/`renderResult` for the model path. Peek = the detailed tier.

---

## Gate per screen (before any screen ships)
- widths 80/62/20, borders valid at 1, `visibleWidth`≤width (unit)
- keys via injected manager + j/k/q aliases; never intercept while editing
- semantic tokens only, state never color-alone (unit snapshot of tokens)
- timers started on mount, cleared on close (unit spies clearInterval)
- destructive (cancel/retention) confirm (unit)
- panel action ≡ nested command ≡ headless for the same app function (table test)
