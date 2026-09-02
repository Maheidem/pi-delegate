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
/delegate status                  mode, active/last run, tool registration
/delegate inspect [runId]         metadata + bounded transcript/stderr
/delegate cancel [runId]          cancel the active (or named) run
/delegate paths                   config/run-store locations
/delegate doctor                  honest environment checks
/delegate help                    syntax + examples
```

Any unrecognized first word is shorthand for `run general …`.

Tool (`delegate`) is available to models: same semantics, JSON result with
`ok`/`handoff`/`details` (usage, paths, state) or structured `error`.

## Safety model (selected invariants)

- The delegated task travels over child **RPC stdin**, never argv.
- Children run with `PI_DELEGATE_CHILD=1`; the extension is inert in children
  (no recursion, no nested delegation).
- `agent_settled` is the only normal completion signal; raw stdout records are
  persisted **before** semantic processing; unknown events are persisted and
  ignored, never dropped.
- Cancellation is idempotent (first wins): RPC abort → SIGTERM → SIGKILL;
  every finalization reaps the child exactly once.
- Run-store is `0700` with `0600` receipt/transcript/stderr files; corrupt
  config is preserved as evidence and defaults are loaded.
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
