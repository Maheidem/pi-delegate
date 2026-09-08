# Delegate UI — Architecture & UX Plan

Status: **FOR REVIEW — no code yet.** This is the planning artifact the redesign must be
approved against before implementation, per `pi-extension-builder` ("plan before changing code").

Grounded in the source of truth, not ad-hoc:
- `skills/pi-extension-builder/references/UX-STANDARD.md`
- `skills/pi-extension-builder/references/CURRENT-EXTENSIONS-AUDIT.md`
- `skills/pi-extension-builder/references/PILOT-RESULTS.md` (Loop = operational-dashboard reference)
- `skills/pi-extension-builder/assets/control-panel/extensions/ui/{settings-panel,panel-model}.ts`
- `custom-extensions/loop/ui/loop-panel.ts` (the concrete `PanelSnapshot` dashboard reference)

---

## 1. Problem statement

The delegate UX is **fragmented across three components with three interaction models**, which
violates the workbench's central principle ("build coherent products, not isolated scripts";
"Dashboard = one custom component **with refresh**"):

| Surface | Component | Mount | Problem |
| --- | --- | --- | --- |
| `/delegate` (dashboard) | `SettingsPanel` (canonical, byte-identical) | `index.ts:897` | Correct primitive, but **incomplete** (§3). |
| run in progress | `RunningView` (**bespoke**) | inline, `index.ts:564` | Second bespoke component; caused the input-bar corruption (fixed for height/width in 0.2.3, but still the wrong *architecture*). |
| peek / post-mortem | `PeekView` (**bespoke**) | overlay, `index.ts:779` | Third bespoke component; different shell than the panel. |

**Governance gaps:**
- `delegate` is **absent from `CURRENT-EXTENSIONS-AUDIT.md`** (audit is dated 2026-09-01, predates delegate) — never assessed.
- `scripts/check-vendored.mjs` tracks loop + audio-transcribe but **not delegate**, so the copied
  `settings-panel.ts` has no drift guard.

**Functional gaps (the "missing options" — every one already exists as a command + app method):**

| Function | command | app method | panel action? |
| --- | --- | --- | --- |
| status | `/delegate status` | `getStatus` | **NO** |
| peek (live/post-mortem feed) | `/delegate peek` | `inspect` | **NO** |
| cancel active | `/delegate cancel` | `getActiveRun`/`cancel` | **NO** |
| resume durable child | `/delegate resume` | `mostRecentRunId`/`run` | **NO** |
| strict on/off | `enable`/`disable` | `enable/disableStrict` | yes (`strict-toggle`) |
| inspect last | `inspect` | `inspect` | yes (`inspect-last`) |
| doctor / paths | `doctor`/`paths` | `doctor`/`paths` | yes |

**Config knobs the engine accepts (`patchConfig` is generic) but the panel omits:**
`stuckToolTimeoutMs` (R1 watchdog — **off by default**), `queueLimit` (the 0.2.2 fan-out queue),
idle·project, `killGraceMs`, `handoffEnforceTimeoutMs`, `handoffGraceMs`, `updateThrottleMs`,
`maxResultBytes`, `maxRuns`/`maxRunAgeDays` (retention — silently purges run evidence).

---

## 2. Archetype decision (per UX-STANDARD §2)

**Control panel (home) that behaves as a Dashboard**, plus **one secondary screen** (the feed).

- Home = the canonical `SettingsPanel`, its `snapshot()` carrying live state, refreshed on a
  1 s timer that is cleared the instant the panel closes (the Loop pattern).
- Secondary = peek/live feed: a scrolling viewport **built on the same shell conventions**
  (width-safe borders, injected keybindings, footer, return-to-home on close). This may remain a
  small dedicated component, but it must be *contract-conformant*, not a parallel design.
- `RunningView` as a standalone inline mount is **retired**: live run state becomes rows/detail
  lines inside the home panel (like Loop's `Next tick` countdown). This is the pivotal change.

---

## 3. Information architecture — home (progressive disclosure, UX-STANDARD §3)

The first screen answers, top to bottom: **Is it working? What is active? What can I change?
Where is detail?** Target ≤ 23 lines at 80 cols; the live feed lives in the secondary screen so
the home never grows.

```
╭─ Delegation ─────────────────────────────────────────────────────────────╮
│ v0.2.3 · normal mode · ✓ engine ok            ← is it working (words+color)│
│ active: del_…9daa (general · glm-5.3) · queue 2/3       ← what's active     │
│ last: general · succeeded · 30m 22s                                          │
│                                                                            │
│ Live run                                                       ← refresh 1s │
│   ▸ general  del_…9daa  glm-5.3                                          │
│   ███████░░░░░░░  41% of 45m hard   turn 12   ↑41k ↓6.2k                  │
│   in flight: bash `pnpm test`                                            │
│   (2 calls queued — one child at a time)                                │
│                                                                            │
│ Actions                                                                    │
│   Run general                     Run research                           │
│   Peek live feed ›              Inspect last run ›                       │
│   Cancel active run   ⚠         Resume last run ›                        │
│   Enable strict mode            Doctor ›        Paths ›                  │
│                                                                            │
│ Timeouts (base)                                   ← editable                 │
│   Hard · user-wide            2h                                          │
│   Hard · project              not set                                     │
│   Idle · user-wide            2h                                          │
│   Idle · project              not set                                     │
│   Stuck-tool                 off       ← R1 in-flight watchdog          │
│                                                                            │
│ Advanced                                          ← editable, disclosure    │
│   Queue limit                3        Kill grace        5s                │
│   Handoff enforce           60s      Handoff grace     90s              │
│   Update throttle           0.1s     Max result bytes  51200            │
│   Retention                 50 / 30d                                    │
│                                                                            │
│ changes save immediately                              ↑/↓ j/k · enter · q │
╰────────────────────────────────────────────────────────────────────────────╯
```

Layout notes:
- Status/summary = the canonical `summaryLines` (working + active + queue + last).
- `Live run` section = info rows + a progress glyph line (progress also spelled in text,
  never color/shape alone — UX-STANDARD §6) fed from the existing `onUpdate`/`onEvent` ring.
- `Actions` = `kind:"action"` rows (Peek/Inspect/Doctor/Paths open secondary text or screens;
  Cancel = `valueStyle:"warning"` + explicit `confirm…`, destructive-confirm per §9).
- Cancel row appears only while active (Loop's contextual-rows idiom).
- Home height grows with the two config sections; if it exceeds ~23 lines at a given width,
  split Advanced behind a `Configure…` action (secondary screen) rather than truncating the
  footer.

---

## 4. Secondary screen — peek / live feed (single scrolling viewport)

```
╭─ Peek · del_…9daa · glm-5.3 · running ───────────────────────────╮
│ ~/.pi/agent/delegate/runs/del_…9daa.jsonl                        │  muted
│ ● live · following · j/k scroll · f re-follow · q back · ↑12 ↓0 │  success
│ +61s ▣ handoff submitted (done)                                 │
│ +52s ✎ ## Outcome — matrix green                              │
│ ...                                                         │
╰───────────────────────────────────────────────────────────────────╯
```
- Fixed-height viewport (already implemented in `peek-view.ts`), same tokens + footer idiom.
- `q`/Esc = **back to home** (not full close) per §5; `f`/Esc-again handling documented in footer.
- Headless: prints the tail to stdout (already done).

---

## 5. Function parity — panel ⇄ nested command ⇄ headless (UX-STANDARD §3, §10)

One canonical action per row; panel and nested commands call the **same** app function.

| Panel row / key | shortcut | nested command | TUI | headless (`pi -p`) |
| --- | --- | --- | --- | --- |
| Run general / research | `g` / `r` | `/delegate run [role] <task>` | editor → live panel | run, print handoff |
| Peek live feed | `p` | `/delegate peek [id]` | secondary screen | print feed tail |
| Cancel active run | `x` | `/delegate cancel [id]` | confirm → cancel | cancel + receipt |
| Resume last run | `R` | `/delegate resume <id> <task>` | editor → run | run with `resumeFrom` |
| Inspect last run | `i` | `/delegate inspect [id]` | report text | report text |
| Enable/disable strict | `s` | `/delegate enable\|disable` | toggle | toggle |
| Doctor | `d` | `/delegate doctor` | report text | report text |
| Paths | `/` | `/delegate paths` | report text | report text |
| (bare) | — | `/delegate` | home panel | `statusText()` |
| status | — | `/delegate status` | (home) | `statusText()` |
| Hard/Idle/Stuck/…knobs | — | `/delegate <key> <value>` | inline input | set + persist |

Completions must return the full nested grammar for all of the above (today completion is partial).

---

## 6. Keyboard, visual, responsive contracts (gates)

- Keybindings injected first (`tui.select.*`); `j/k/q` + mnemonic letters only when shown in the
  footer; never intercept printable keys while an `Input`/`Editor` owns focus (§5).
- Semantic tokens only (`accent/success/error/warning/muted/dim/text`); **never color alone** (§6).
- Every `render(width)` line ≤ width at **80 / 62 / 20**; borders valid at width 1; ANSI-aware
  clipping (§8).
- Live panel: refresh timer started after mount, **cleared on close** (§9); timers/listeners
  cleaned in `session_shutdown`.
- Destructive (cancel/reset) require confirmation with scope (§9).
- Tests run in isolated `HOME` (§ non-negotiables).

---

## 7. Migration slices (behavior-neutral, each gated — never mix UI rewrite with logic)

**Slice 0 — governance + inventory (no behavior change).**
Add `delegate` to `check-vendored.mjs`; add a failing-till-green parity test enumerating the §5
table against the parser + app methods; assert vendored `settings-panel.ts` is byte-identical.
Gates: typecheck, unit.

**Slice 1 — home panel model.** Rewrite `dashboardSnapshot` → full model (§3): live status rows,
complete actions (add peek/cancel/resume/status), base + advanced config sections wired through the
**generic** `patchConfig` (delete the hardcoded apply switch). Cancel is confirm-gated. Home stays
≤ budget or defers Advanced to a secondary screen.
Gates: unit (snapshot shape, row routing, widths 80/62/20, cancel-arm, queue row), `/reload` smoke.

**Slice 2 — fold live run into the panel; retire `RunningView`.** The run path no longer mounts a
bespoke inline component; instead the home panel (or a focused live sub-view built on the same
shell) shows progress/in-flight/feed via `refresh()` from the existing ring; Esc arms cancel.
Delete `ui/running-view.ts` (or reduce to a snapshot helper consumed by the panel).
Gates: unit (live snapshot, fixed height, widths), e2e long-tool survives + cancel.

**Slice 3 — peek as contract-conformant secondary screen.** Confirm shell/keys/footer match the
panel; `q` returns home; headless tail intact. Register any residual bespoke component + tests.
Gates: unit (peek viewport, widths, back-nav), e2e K.

**Slice 4 — completions + parity hardening.** Full nested completion for all verbs/knobs; assert
panel action ≡ nested command ≡ headless in one table test.
Gates: completion test, headless print test.

Ship as **0.3.0** (architectural change) — not a patch bump.

---

## 8. Decisions — RESOLVED 2026-09-04

- **D1 (pivotal): BOTH.** Compact live strip inline in the shell *during* execution (composer
  strip S4 for the slash path; tool `renderCall`/`renderResult` S5 for the model path) **AND** a
  richer detailed tier inside `/delegate` (home Live block S2 + Peek S6). So `running-view` is
  **kept** as the compact fixed-height inline strip (NOT retired) and mirrored in the home panel.
- **D2: Peek = detailed tier (S6)**, contract-conformant, `q` = back to home.
- **D3: Tuck Advanced behind a `Configure advanced… ›` screen (S7).** Home ≈ 15–18 lines.
- **D4: register `delegate` in `check-vendored.mjs`** (Slice 0). YES.
- **D5: ship as `0.3.0`** (architectural). YES.
- **Go-ahead: review mockups first.** Full visual spec + journey in `SCREENS.md`; implement only
  after the user approves the mockups.
