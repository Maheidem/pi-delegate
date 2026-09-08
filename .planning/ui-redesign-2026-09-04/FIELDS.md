# Delegate UI — Field-Level Technical Specification

Blueprint companion to `PLAN.md` (decisions §8) and `SCREENS.md` (S1–S11 mockups). This defines
**every displayed field: which screen, what it means, where the data comes from, and the rules**
(format, bounds, fallback, show/hide, never-color-alone). Implement against this, not the mockups
alone. Sources are the real types in `types.ts`, `config.ts`, `transcript-feed.ts`, `version.ts`.

Design posture (per `pi-extension-builder`): **reuse the unified primitives, build the least new
surface.** §7 maps every screen to an existing primitive; only the model-tool inline (S5) is new.

---

## 1. Sources of truth (data plumbing)

| Live data | produced by | delivered via | consumed by |
| --- | --- | --- | --- |
| `RunStreamUpdate` (`types.ts`) | runner → `app.run` | `RunHooks.onUpdate` (throttled `updateThrottleMs`) | S2 home-live, S4 inline strip |
| `FeedEvent` (`transcript-feed.ts`) | runner events | `RunHooks.onEvent` → `FeedRing` | S2 tail, S4 tail, S5 live tail, S6 peek |
| transcript tail | captured child JSONL | `feedEventsFromTranscript()` | S6 peek (incl. post-mortem) |
| `DelegateStatus` (`types.ts`) | `app.getStatus(activeTools, projectRoot)` | direct call each snapshot/refresh | S1 home summary, rows |
| `DelegateDetails` (`types.ts`) | finalized run (`app.inspect`) | direct | S5 final card, S9 reports |
| `DelegateConfigV1` (`config.ts`) | `liveConfig` | `getStatus().timeouts` / direct | S1 base, S7 advanced |
| version | `delegateVersion()` (`version.ts`) | direct | everywhere, row 1 |
| queue depth / limit | `app.queuedRunCount()` / `app.queueLimit()` | direct | summary line |

**Refresh contract:** home/live screens re-snapshot on a 1 s timer started after mount and cleared
the instant the screen closes (`session_shutdown` too). `running-view`/`peek` never mutate state —
they render a snapshot.

---

## 2. Canonical formatters (ONE module — do not re-roll per component)

Create `ui/format.ts`; every view imports it. (Today `running-view.ts` duplicates
`fmtDuration`/`fmtTokens` — fold them here.)

| helper | rule | source | example |
| --- | --- | --- | --- |
| `formatDuration(ms)` | `?` if !finite/<0; `<1s`→`Xms`; `<60s`→`Xs`; `<60m`→`Xm[ Ys]`; `<24h`→`Xh[ Ym]`; else `Xd[ Yh]` | **reuse `config.ts:243`** | `41s`, `30m 22s`, `2h`, `1d 3h` |
| `formatTokens(n)` | `0` if falsy; `<1000`→raw; `<1M`→`X.Yk`; else `X.YM` | new (was bespoke) | `6.2k`, `41k` |
| `formatSize(bytes)` | binary `B/KB/MB/GB`, 0–1 decimal | reuse template `formatSize` | `51 KB` |
| `clip(text,max)` | collapse whitespace, trim, `…` at max chars | reuse `transcript-feed.clip` | — |
| `shortModel("zai/glm-5.3")` | part after `/` (compact rows); full id in peek header | new | `glm-5.3` |

**Never** use `String.length` for layout — always `visibleWidth`/`truncateToWidth` (§8).

---

## 3. Field dictionary (the blueprint)

Glyph + word always together — **never color alone** (§6). `valueStyle` = semantic token.

### 3.1 Identity & health (home row 1)
| field | glyph/word | source | rule | shown |
| --- | --- | --- | --- | --- |
| health | `✓ ready` / `! degraded` / `✗ error` | `doctor().ok` + `status.timeouts.projectCorrupt` | `✓ ready` only if all checks ok; else `!`/`✗` + first bad check word | always |
| version | `v0.3.0` | `delegateVersion()` | loaded-code version; append `(reload for newer)` when store is ahead | always |
| mode | `normal` / `strict` | `status.modeEnabled` | word + `accent` when strict | always |

### 3.2 Active / queue / last (home row 2)
| field | source | rule | shown |
| --- | --- | --- | --- |
| active | `status.activeRun` → `del_…{last8} (role · shortModel)` | `active: none` when null; role short, model short | always |
| queue | `queuedRunCount()`/`queueLimit()` → `queue: N/M` | `0/M` when empty | always |
| last | `status.lastRun` → `last: role · state-word · duration` | `formatDuration(durationMs)`; omit duration if null | always |

### 3.3 Live run block (S2 home-live · S4 inline strip) — from `RunStreamUpdate` + ring
| token | source | rule | notes |
| --- | --- | --- | --- |
| phase dot | `u.phase` | `◐ starting` · `● running` · `● running` (`tool:*`) · `◉ finalizing` | glyph+word |
| role | `u.role` | `general`/`research` | word |
| model | `u.model` | `shortModel`; if absent `model: default` | — |
| elapsed | `u.elapsedMs` | `formatDuration` | left of bar |
| progress | `elapsedMs / hardMs` | bar `█░` + ` NN%`; **only if hardMs>0**, else `elapsed Xs (no cap)` | number always, bar cosmetic |
| hard | `hardMs` (effective) | `of {formatDuration} hard` | — |
| turn | `u.usage.turns` | `turn N`; omit if 0/undefined | — |
| tokens | `u.usage.input/output` | `↑{formatTokens} ↓{formatTokens}` | compact |
| cost *(opt)* | `u.usage.cost` | `· ${cost.toFixed(2)}`; **no emoji**; off by default, on in peek | text-only |
| in flight | `u.openTools` (+ last matching `tool_start` FeedEvent detail) | `in flight: {tool} \`{arg}\``; `running` when empty | warning when >0 |
| tail | `FeedRing.tail(k)` via `renderFeedEvents` | newest at bottom, newest `k=5` here | see §5 |

**Fixed-height rule (the input-bar fix):** live blocks render a **constant row count** (S4 = 6
rows), blank-padded, borders **unstyled** so Pi's width/clear math is exact. Row count must never
change between refreshes.

### 3.4 Timeouts (base, S1) — editable `input`, from `status.timeouts`
| row | field | source | format | fallback |
| --- | --- | --- | --- | --- |
| Hard · user-wide | `userHardMs` | config cascade | `formatDuration` | — |
| Hard · project | `projectHardMs` | project overlay | `formatDuration` / `not set` | `not set` muted |
| Idle · user-wide | `userInactivityMs` | config | `formatDuration` | — |
| Idle · project | (project) | overlay | `formatDuration` / `not set` | `not set` |
| Stuck-tool · base | `stuckToolTimeoutMs` | config (default **undefined**) | `off` when undefined + `warning`; else `formatDuration` | annotate "R1 watchdog" |

Edit rule: input → `app.patchConfig(key, raw)` (generic) → clamp to `MIN/MAX_VALUES` (`config.ts`)
→ echo resulting formatted value; invalid stays editable + explains range (§7).

### 3.5 Advanced (S7 secondary) — editable `input`, from `liveConfig`
| row | key | default | bounds (min–max) | format | note |
| --- | --- | --- | --- | --- | --- |
| Queue limit | `queueLimit` | 3 | 0–20 | int | concurrent calls serialized |
| Kill grace | `killGraceMs` | 5s | 100ms–60s | duration | SIGTERM→SIGKILL |
| Handoff enforce | `handoffEnforceTimeoutMs` | 60s | 1s–600s | duration | bounded handoff wait |
| Handoff grace | `handoffGraceMs` | 90s | 1s–600s | duration | post-kill answer wait |
| Update throttle | `updateThrottleMs` | 0.1s | 0–5000ms | duration | onUpdate cadence |
| Max result bytes | `maxResultBytes` | 51200 | 1KB–10MB | `formatSize` | parent-visible cap |
| Retention | `maxRuns` / `maxRunAgeDays` | 50 / 30d | 1–10000 / 1–3650 | `N runs / Nd` | ⚠ purges run evidence — warn on lower |
| Max task bytes | `maxTaskBytes` | 32768 | 1KB–1MB | `formatSize` | task input cap |

### 3.6 State vocabulary (all screens) — glyph + word + token
| state (`RunTerminalState`/`RunState`) | glyph | word | token |
| --- | --- | --- | --- |
| created / starting | `◐` | starting | muted |
| running | `●` | running | success |
| succeeded | `✓` | done | success |
| cancelled | `⊘` | cancelled | muted (**not** error) |
| timed_out_idle | `⏱` | timeout · idle | warning |
| timed_out_hard | `⏱` | timeout · hard | warning |
| crashed | `✗` | crashed | error |
| queued (view-only) | `○` | queued | muted |

### 3.7 Feed marks (S2/S4 tail, S6 peek) — `renderFeedEvents` (`transcript-feed.ts`)
`▶` tool_start · `✓`/`✗` tool_end (+`(Ns)`) · `✎` assistant · `⚠` provider_error ·
`▣` handoff · `◉` settled · `·` info. Prefix `+{Ns}`/`+XmYYs` relative to run start. End line
echoes start's arg detail (path/command); **bash** keeps its output head; file-content heads are
suppressed as noise (documented behavior).

### 3.8 Final card (S5 done / S9 inspect) — from `DelegateDetails` + `handoffData`
`Outcome`(handoffData.outcome) · `Changes[]` · `Verification[]` · `Remaining[]` · `Risks[]` (when
present) · duration `formatDuration(durationMs)` · `stopReason` (non-`stop` only) ·
`timeoutInfo` (`hard 45m (per-run) · idle 22m30s`) · `outputTruncated` → "output truncated" note ·
`transcriptPath` / `sessionPath` → peek/resume hints. **error:** line only for real `E_*`
failures (§3.6 maps cancelled/timeout to neutral/warning).

---

## 4. Per-screen field layout (screen → exact rows)

- **S1 home (idle):** §3.1 row · §3.2 row · Actions (§7) · §3.4 base table · `Configure advanced… ›`.
- **S2 home (live):** §3.1/§3.2 · **Live run block** = phase+shortModel+`turn`+tokens / bar+hard
  / in-flight / tail(k=5) · Actions reduced to Peek/Cancel/Doctor/Paths · base collapses to one
  line · footer `esc×2 cancel · q close`.
- **S4 inline strip (slash, composer):** fixed 6 rows = title(role·shortModel·elapsed) / bar+turn+
  tokens / in-flight / tail(k=3) / hint(`esc×2 cancel · q peek`). Constant height (§3.3 rule).
- **S5 inline tool (model, transcript):** see §5.
- **S6 peek:** header(id·role·shortModel·state) / summary(`transcriptPath`) / status(live·keys·counts)
  / feed window(k=14, scrolling) / footer. Post-mortem: state from `inspect().metadata.state`.
- **S7 advanced:** §3.5 rows (all `input`, generic patch).
- **S8 cancel confirm:** `runId`, role, shortModel, elapsed, resume hint (`sessionPath`).
- **S9 reports:** Doctor rows (`DoctorReport.checks[]`: name+status-token+detail); Paths
  (`paths()`); Inspect (`DelegateDetails` fields, `transcriptPreview` when requested).

---

## 5. S5 — inline execution tail (the enhancement you asked for)

Both paths read **one** feed (the runner `FeedRing`) so live and detailed never diverge.

**During (model tool `renderCall` + `onUpdate` partialResult):**
```
⚙ delegate ▸ general · glm-5.3 · 41% of 45m · turn 12 · in flight: bash `pnpm test` (22s)
  +31s ▶ bash pnpm test
  +18s ✓ read src/audio/engine.ts (3s)
  +9s  ✎ ## Outcome — audio path refactor lands
```
- Line 1 = identity+progress (§3.3 compact). Lines 2–4 = **live tail k=3** (last 3 `FeedEvent`s,
  `renderFeedEvents`, newest last), clipped to width.
- partialResult payload: `{ phase, pct, hardMs, model, role, turn, inFlight, tail: ring.tail(5) }`.
- Bound: inline tail **≤ 5 lines**; whole inline block **≤ 8 rows** so it never floods the
  transcript. Full detail lives in peek (`/delegate peek <id>`).

**After (model tool `renderResult`) — final card, §3.8:**
```
✓ delegate del_…9daa · general · glm-5.3 · 7m31s · done
    ▸ Outcome: audio path refactor; 3 files changed, tests 38/38
    ▸ last: "## Outcome — audio path refactor lands"
    ▸ Verification pnpm test · build   ▸ Remaining none
    peek /delegate peek del_…9daa · resume resumeFrom del_…9daa
```
- "last" = last `assistant` FeedEvent head (or `handoffData.outcome` head) → the last agent message.
- cancelled/timed-out render with §3.6 neutral/warning glyphs, never `error:`.

**Slash path (`/delegate run`) during:** S4 strip (§4) shows the same tail live.

---

## 6. Keyboard / width / token invariants (gates) — restate
- Keybindings via injected manager (`tui.select.up/down/confirm/cancel`) first; `j/k` + mnemonic
  letters only when in footer; never intercept printable keys while `Input`/`Editor` owns focus.
- `render(width)` line `visibleWidth ≤ width` at **80 / 62 / 20**; borders valid at width 1; ANSI-
  aware clip. Fixed-height live blocks (§3.3).
- Semantic tokens only (`accent/success/warning/error/muted/dim/text`); state never color-alone.
- Timers: start on mount, `clearInterval` on close + `session_shutdown`; destructive confirm.

---

## 7. Reuse map — what each screen uses (build the least new surface)

| screen | primitive | status |
| --- | --- | --- |
| S1/S2 home, S7 advanced, S9 reports | **vendored `SettingsPanel`** (canonical `PanelSnapshot`) | reuse — already byte-identical to kit |
| live row vocabulary | `PanelRow`/`PanelValueStyle`/`shortcuts`/`idleMessage`/`detailLines` | reuse — match `loop-panel.ts` idiom exactly |
| all feeds (S2/S4/S5/S6 tail) | `renderFeedEvents` + `FeedRing` (`transcript-feed.ts`) | reuse — one formatter |
| formatting | **new `ui/format.ts`** wrapping `config.formatDuration` + `formatSize` | create thin; delete bespoke `fmtDuration`/`fmtTokens` |
| spawning/await wait | **`BorderedLoader`** / `setWorkingIndicator` (Pi) | reuse, don't custom-spin |
| S6 peek scrolling | same width-safe viewport **mechanics** as model-discovery `wizard-shell` | copy-consistent (kit unpublished per PILOT-RESULTS — vendored, registered) |
| S4 inline strip | keep `running-view.ts`, refactored to fixed-height + `ui/format.ts` | refactor in place |
| S5 inline tool | **`renderCall`/`renderResult`** on the `delegate` tool (todo.ts pattern) | **the only genuinely new code** |
| S3 editor, completion | Pi `ctx.ui.editor`, `registerCommand` completion | reuse |

**Cross-extension consistency:** delegate home rows are authored as the same `PanelSnapshot`
vocabulary loop uses (`kind`, `valueStyle`, `shortcuts`, `idleMessage`, `detailLines`) — no new
row kinds. Governance: register `delegate/ui/settings-panel.ts` (+ any vendored viewport) in
`scripts/check-vendored.mjs` so drift is guarded like loop/audio (§ PLAN Slice 0).

---

## 8. Field→test matrix (every field has a guard before it ships)
- formatter unit tests: `formatDuration` bounds incl. `?`, `formatTokens` 999/1000/1M, `formatSize`.
- snapshot model tests: home idle vs live produce correct fields; cancelled→neutral glyph; live block
  **fixed row count** across empty/partial/full; tokens never color-alone (assert word present).
- feed test: tail k-cap, `+Ns` stamps, bash-head rule.
- width tests: 80/62/20 for every screen incl. fixed-height strip.
- parity test: each home/advanced row key ≡ nested command ≡ headless stdout (table).
- inline tool test: `renderCall` tail ≤5 lines, `renderResult` cards per state (done/cancel/timeout).
