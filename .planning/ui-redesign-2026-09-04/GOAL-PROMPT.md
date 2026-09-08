# GOAL PROMPT — Delegate TUI redesign to a validated deliverable (with visual evidence)

> Hand this whole file to a fresh agent. It is self-contained. Work in
> `/Users/maheidem/Documents/dev/pi-coder-management/custom-extensions/delegate`.

## 0. Your mission (one sentence)
Redesign the `@maheidem/pi-delegate` Pi extension's terminal UI into **one coherent,
skill-compliant centralized experience** — a home dashboard, a live inline execution view (both the
slash-composer strip and the model's tool card), a detailed peek screen, and a config screen —
**build the least new surface** (reuse the shared primitives), fully tested, **with real terminal
screenshots proving every screen renders correctly**, then ship it as **v0.3.0**.

## 1. What this thing is (context you need)
`delegate` lets the main Pi agent hand a bounded subtask to an isolated child Pi session and get
back a **structured handoff**. It runs **one child at a time**; concurrent calls **queue** (a
fan-out serializes). Children stream events (tool starts/ends, assistant text, provider errors,
handoff) that we render as a live feed. Runs persist receipts + transcripts under
`~/.pi/agent/delegate/runs/`. The child must submit results by calling a mandatory `handoff`
tool (validated protocol, not free text).

Read these **before touching code** (source of truth, in this order):
1. `skills/pi-extension-builder/SKILL.md` — the mandated workflow.
2. `skills/pi-extension-builder/references/UX-STANDARD.md` — the rules (esp. §2 archetypes,
   §4 panel anatomy, §6 tokens / never-color-alone, §8 width, §9 async/destructive, §10 headless).
3. `skills/pi-extension-builder/references/CURRENT-EXTENSIONS-AUDIT.md` + `PILOT-RESULTS.md`
   (**Loop is the dashboard reference**: one `SettingsPanel` + `PanelSnapshot` + `refresh()`).
4. `custom-extensions/loop/ui/loop-panel.ts` — concrete `PanelSnapshot` example to imitate.
5. **THE BLUEPRINT** (this redesign), in `custom-extensions/delegate/.planning/ui-redesign-2026-09-04/`:
   - `PLAN.md` — architecture, migration slices 0→4, **resolved decisions §8**.
   - `SCREENS.md` — mockups S1–S11 + user journey.
   - `FIELDS.md` — **field-by-field spec: every token, its source, format, bounds, fallback,
     show/hide, glyph+word.** Build to this.
   - `GOAL-PROMPT.md` — this file.
   - `capture/` + `evidence/` — the visual-evidence toolchain (already proven; see §6).
6. Pi docs (installed, absolute): `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
   → `tui.md` (custom UI, `BorderedLoader`, `setWorkingIndicator`, tool `renderCall`/`renderResult`
   via `examples/extensions/todo.ts`), `extensions.md`, `keybindings.md`, `rpc.md`, `packages.md`.

## 2. Decisions already made — do not re-litigate
- **Centralized window**, Loop model: bare `/delegate` → the vendored canonical **`SettingsPanel`**
  (`PanelSnapshot`) that also acts as a **live dashboard** via `refresh()` (1 s timer, cleared on
  close). Do **not** build a new panel component.
- **D1 = both live views:** (a) compact **inline execution** *during* a run — composer strip
  (`running-view.ts`, refactored, fixed-height) for the slash path **and** the tool's
  **`renderCall`/`renderResult`** for the model path (this is the only genuinely new code);
  (b) a **detailed peek** screen (S6) for full depth. Same feed source (`FeedRing`).
- **Advanced config tucked** behind `Configure advanced… ›` (S7). Home ≈ 15–18 lines.
- **Model id:** short (`glm-5.3`) in rows; full (`zai/glm-5.3`) only in the peek header.
- **Inline usage:** `↑in ↓out` tokens are **primary**; **cost** shown too but secondary/dim
  (`· $0.42`), inline-compact optional, always on the final card + peek.
- **Ship as 0.3.0.** Publish + install only at the end, with human in the loop (§8).

## 3. Concrete reuse mandate (do NOT recreate)
- Vendored `ui/settings-panel.ts` + `PanelSnapshot` for home/advanced/reports — author rows with
  the **exact vocabulary `loop-panel.ts` uses** (`kind`, `valueStyle`, `shortcuts`, `idleMessage`,
  `detailLines`). No new row kinds.
- **`ui/format.ts` (create thin):** wrap the canonical `formatDuration` (`config.ts`) +
  `formatSize` + one `formatTokens` + `shortModel`. **Delete** the duplicate `fmtDuration`/
  `fmtTokens` currently living in `running-view.ts`. Every view imports `ui/format.ts`.
- One feed formatter everywhere: `transcript-feed.ts` `renderFeedEvents` + `FeedRing`.
- Waits use Pi's `BorderedLoader` / `setWorkingIndicator` — no custom spinners.
- Peek reuses model-discovery `wizard-shell` **viewport mechanics** (vendored + registered), since
  the runtime kit stays unpublished (see `PILOT-RESULTS`).

## 4. Environment / facts (verified on this machine)
- Repo is its own git repo; **HEAD `0a8032e`, v0.2.3** committed+published+installed. Confirm with
  `git -C . log --oneline -1` and `grep '"version"' package.json`.
- The version Pi actually runs = the **store** copy:
  `grep '"version"' ~/.pi/agent/npm/node_modules/@maheidem/pi-delegate/package.json` (currently 0.2.3).
- `ui/settings-panel.ts` is **byte-identical to the canonical kit** — keep it that way
  (`node ../../skills/pi-extension-builder/scripts/check-vendored.mjs`). delegate is **not yet**
  registered in that script — Slice 0 adds it.
- Local model server: **oMLX `127.0.0.1:8123`** (default `local-mac/…`). `npm run test:e2e` needs
  it up; `E2E_SCENARIOS=A,J` runs a subset. Unit = `npm test`; typecheck = `npm run typecheck`.
- Publish flow (AGENTS.md): `npm test` → bump `package.json` → commit+push → `npm publish`
  (**2FA OTP must be typed in a real terminal — you cannot automate this**) →
  `pi install npm:@maheidem/pi-delegate@0.3.0` → tell the user to `/reload`. Registry can lag
  ~30 s after publish → retry the install once after a short wait.

## 5. Build order — behavior-neutral slices, each gated (never mix UI rewrite with logic)
Do them in order; run the gates after each; report results; stop and ask if a gate fails twice.
- **Slice 0 — governance + contract tests (no behavior change).**
  Register `delegate` in `skills/.../check-vendored.mjs`; add `tests/parity.test.ts` asserting the
  **§5 FIELDS.md command/panel/headless parity table** against the real parser + app methods; add
  formatter + fixed-height + width (80/62/20) tests (they may start red — that's the spec).
  Gate: `npm run typecheck && npm test`.
- **Slice 1 — home + advanced panel model.** Rewrite `dashboardSnapshot` → full `PanelSnapshot`:
  summary (§3.1–3.2), Actions incl. **Peek/Cancel/Resume/status** (missing today), base Timeouts
  (§3.4) incl. idle·project + stuck-tool, `Configure advanced… ›` → S7 secondary screen (all knobs
  §3.5) via **generic** `app.patchConfig` (delete the hardcoded `apply` switch). Cancel = confirm.
  Gate: unit snapshot/row-routing/widths/cancel-arm + `/reload` smoke by the user.
- **Slice 2 — live inline (the risky one; check in after).** Refactor `running-view.ts` to the
  **fixed-height 6-row** strip (S4) reading `RunStreamUpdate` + `ring.tail()`; **implement the
  tool's `renderCall` (live tail ≤5 lines) + `renderResult` (final card §3.8)** so the model path
  stops emitting bare `error:`; map states to §3.6 glyphs (cancelled/timeout **neutral**, not error).
  Mirror live state in the home Live block via `refresh()`. Gate: unit (fixed row count, tail cap,
  per-state cards) + `E2E_SCENARIOS=G,H npm run test:e2e` (long tool survives, partial handoff).
- **Slice 3 — peek as conformant secondary screen (S6).** Fixed-height viewport, keys/tokens/footer
  match the panel, `q` = back to home, headless tail intact. Gate: unit + `E2E_SCENARIOS=K`.
- **Slice 4 — completions + parity hardening + README.** Full nested completion (S11); one table
  test proving panel action ≡ nested command ≡ headless stdout; README documents the new surfaces.

## 6. Visual evidence — REQUIRED, and HOW (toolchain already proven here)
A screen is not "done" until it has a PNG in `evidence/shots/`. Two proven mechanisms:

**A. Deterministic component render (no model, 100% reproducible) — every screen × 80/62/20.**
`capture/capture-deterministic.mjs` (write in Slice 1–3 as components exist): import the real
component + a real theme + a **scripted fake state timeline** (idle → queued → running+tool →
handoff → done, and a cancelled variant), call `render(width)` per frame, emit ANSI, pipe through
`capture/ansi_to_png.py` → PNG. Proves layout/color/width independent of model output.

**B. Live capture from the real running TUI (proof it actually works) — true color.**
`capture/capture-live.sh` (provided, tested mechanism): launches `pi` in tmux at a fixed size,
drives the screens with `send-keys`, and `tmux capture-pane -e` (true-color) → `ansi_to_png.py`
→ PNG. Idle/report screens need no model; live-strip/peek frames (`run …`) need oMLX up.
Stitch live frames to a GIF with `capture/to-gif.sh` (ffmpeg).

Proven this session: `capture/ansi_to_png.py` renders colored ANSI→PNG, and tmux `capture-pane -e`
→ PIL → PNG both work (see `evidence/shots/proof-*.png`). The pipeline is real, not hypothetical.

**Required artifact set (all under `.planning/ui-redesign-2026-09-04/evidence/`):**
- `shots/S1-home@{80,62,20}.png`, `S2-home-live.png`, `S4-inline-strip.png`, `S6-peek.png`,
  `S7-advanced.png`, `S8-cancel-confirm.png`, `S9-doctor.png`, `S9-paths.png`.
- `shots/toolpath-during.png` + `shots/toolpath-done.png` + `shots/toolpath-cancelled.png`
  (the S5 model-path card — the thing the user specifically wants fixed).
- `demo.gif` — live sequence: `/delegate` → run → live strip → peek → back → cancel confirm.
- `real-session.html` — Pi's own HTML export of a real delegating session (durable transcript/inline
  evidence): generate via pi's `export-html` (see dist `core/export-html/`).
- `manifest.json` — machine-readable: each screen → required file(s) → **what it must show**
  (e.g. `S4-inline-strip`: "6 fixed rows, non-empty tail, tokens visible, border intact at width 80").

## 7. Definition of Done (all must hold)
- [ ] typecheck 0 errors; **unit 100% green** (includes the new parity, format, fixed-height,
      per-state-card, width 80/62/20 tests); relevant e2e slices green (G/H/K).
- [ ] Home / advanced / reports are the **vendored canonical `SettingsPanel`**; `check-vendored.mjs`
      passes with delegate registered.
- [ ] Every missing function is reachable from the panel AND nested command AND headless:
      status, run(general/research), peek, cancel(confirm), resume, strict toggle, inspect, doctor,
      paths, configure-advanced.
- [ ] Live inline works on BOTH paths; model path no longer shows bare `error:`; cancelled/timeout
      render neutral/warning with a resume hint. Live blocks are fixed-height (no input-bar smear).
- [ ] Tokens ↑/↓ primary inline; cost shown secondary. Model short/full per §2.
- [ ] All `render(width)` lines `visibleWidth ≤ width` at 80/62/20; borders valid at width 1;
      state never color-alone; timers cleared on close + `session_shutdown`; destructive confirm.
- [ ] **Every required visual artifact exists in `evidence/shots/` (+ `demo.gif`, `real-session.html`)**
      and `manifest.json` maps them; a human has eyeballed the PNGs (attach them in your report).
- [ ] README + command help document the surfaces.
- [ ] Published `@maheidem/pi-delegate@0.3.0`, `pi install`ed, and **the user reminded to `/reload`**.

## 8. Guardrails
- Do **not** publish or touch the live Pi install until §7 tests + visual evidence pass AND the user
  approves; `npm publish` needs a real-terminal OTP — hand that step to the user.
- Do **not** rewrite core `dist/`; use documented extension hooks only.
- Do **not** edit `skills/pi-extension-builder/assets/control-panel/*` to make delegate fit — the
  panel is shared; express delegate needs via `PanelSnapshot`, keep vendored bytes identical.
- `edit` oldText must match current disk (this workspace is multi-session); re-read before editing.
- When unsure between a clever approach and the skill's prescribed one, **follow the skill** and
  note the tension.

## 9. How to ask for help
If a required tool is missing, a gate fails twice, or an architectural fork appears that §2 doesn't
cover, **stop and ask the user** with the specific blocker + the smallest decision needed. Do not
silently change scope.

## 10. What to report back
Final message: (1) slice-by-slice what changed with test outputs; (2) the `evidence/` PNG set
(inline the key ones) + `manifest.json`; (3) `git` commit(s) + the published version; (4) the
`/reload` reminder; (5) any decisions you had to make and why.
