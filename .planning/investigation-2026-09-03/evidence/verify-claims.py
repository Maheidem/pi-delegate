#!/usr/bin/env python3
"""
verify-claims.py — independent re-derivation of every load-bearing number in
REPORT.md (investigation-2026-09-03) from PRIMARY sources only:
  - the parent session JSONL (ground truth)
  - the run receipts + raw RPC transcripts in ~/.pi/agent/delegate/runs/
  - the delegate extension source
  - npm publish timestamps
Run: python3 verify-claims.py   (prints a claims table; no writes)
"""
import json, glob, os, subprocess, datetime, base64

def dec(e):
    r = e.get("raw")
    if r:
        try: return json.loads(r)
        except Exception: return None
    if e.get("rawBase64"):
        try: return json.loads(base64.b64decode(e["rawBase64"]))
        except Exception: return None
    return None

RUNS = os.path.expanduser("~/.pi/agent/delegate/runs")
PARENT = ("/Users/maheidem/.pi/agent/sessions/--Users-maheidem-Documents-dev-pi-coder-management--/"
          "2026-09-02T17-18-47-672Z_01a06321-6378-7065-b902-6d454b543fc5.jsonl")
SRC = "/Users/maheidem/Documents/dev/pi-coder-management/custom-extensions/delegate"
pt = lambda s: datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))

SNAPSHOT = "2026-09-03T13:04:05"  # report snapshot = goal-resume msg; session is live and kept delegating after this

results = []
def check(name, found, expected, note=""):
    ok = "OK " if str(found) == str(expected) else "MISMATCH"
    results.append(f"[{ok}] {name}\n       found:    {found}\n       expected: {expected} {note}")
    return found

# ── C1: call/result counts + failure mix (parent session) ──────────────────
calls, res_by_id = {}, {}
for line in open(PARENT):
    m = json.loads(line)
    if (m.get("timestamp") or "") > SNAPSHOT: continue
    msg = m.get("message") or {}
    if msg.get("role") == "assistant":
        for b in (msg.get("content") or []):
            if isinstance(b, dict) and b.get("type") == "toolCall" and b.get("name") == "delegate":
                calls[b["id"]] = (m.get("timestamp"), b.get("arguments") or {})
    elif msg.get("role") == "toolResult" and msg.get("toolName") == "delegate":
        res_by_id[msg.get("toolCallId")] = m
mix = {}
for cid, (ts, args) in calls.items():
    st = ((res_by_id.get(cid) or {}).get("message") or {}).get("details", {}).get("state")
    mix[st] = mix.get(st, 0) + 1
n_fail = sum(v for k, v in mix.items() if k != "succeeded")
check("C1a call count", len(calls), 58)
check("C1b state mix", dict(sorted(mix.items())), {"cancelled": 1, "failed": 1, "succeeded": 47, "timed_out_hard": 4, "timed_out_idle": 5})

# ── C2: cost / wall / tokens / parent absorption ────────────────────────────
cost = wall = out = 0
f_cost = f_wall = f_out = 0
for cid, (ts, args) in calls.items():
    d = ((res_by_id.get(cid) or {}).get("message") or {}).get("details", {}) or {}
    u = d.get("usage") or {}
    c = u.get("cost")
    c = c.get("total") if isinstance(c, dict) else (c or 0)
    cost += c; wall += d.get("durationMs") or 0; out += u.get("output") or 0
    if d.get("state") != "succeeded":
        f_cost += c; f_wall += d.get("durationMs") or 0; f_out += u.get("output") or 0
check("C2a total/failed USD", (round(cost, 4), round(f_cost, 4)), (5.0749, 0.9752))
check("C2b child wall min", (round(wall / 60000, 1), round(f_wall / 60000, 1)), (512.4, 231.8))
check("C2c out-tok", (out, f_out), (315882, 96542))
# parent absorption window: final death 12:30:48Z -> goal-resume 13:04:05Z
cut0, cut1 = "2026-09-03T12:30:48", "2026-09-03T13:04:05"
pcalls = pout = pin = 0
deleg_after = 0
for line in open(PARENT):
    m = json.loads(line)
    msg = m.get("message") or {}
    ts = m.get("timestamp") or ""
    if ts < cut0: continue
    if msg.get("role") == "assistant":
        if ts <= cut1:
            u = msg.get("usage") or {}
            pout += u.get("output") or 0; pin += u.get("input") or 0
            for b in (msg.get("content") or []):
                if isinstance(b, dict) and b.get("type") == "toolCall": pcalls += 1
        for b in (msg.get("content") or []):
            if isinstance(b, dict) and b.get("type") == "toolCall" and b.get("name") == "delegate":
                deleg_after += 1
check("C2d absorption 12:30:48->13:04:05 (calls/out/in)", (pcalls, pout, pin), (28, 30119, 119677))
# whole-file (live session): the parent resumed delegating at 14:54:10Z (independent pre-release audit)
check("C2e delegate calls after final death (live, as of report time)", deleg_after >= 1, True)
in_win = 0
for line in open(PARENT):
    m = json.loads(line)
    ts = m.get("timestamp") or ""
    if not (cut0 < ts <= cut1): continue
    msg = m.get("message") or {}
    if msg.get("role") == "assistant":
        for b in (msg.get("content") or []):
            if isinstance(b, dict) and b.get("type") == "toolCall" and b.get("name") == "delegate":
                in_win += 1
check("C2f no delegate calls in absorption window", in_win, 0)

# ── C3: silence gaps (largest inter-receivedAt gap, and is it inside one tool call) ──
def gap_analysis(fname):
    recs = []
    for l in open(os.path.join(RUNS, fname)):
        if not l.strip(): continue
        e = json.loads(l)
        recs.append((pt(e["receivedAt"]), dec(e) or {}))
    best = (0, -1)
    for i in range(1, len(recs)):
        g = (recs[i][0] - recs[i-1][0]).total_seconds()
        if g > best[0]: best = (g, i)
    g, i = best
    # walk back to the enclosing tool call
    before = [r for _, r in recs[:i] if r.get("type") == "tool_execution_start"]
    after = [r for _, r in recs[i:] if r.get("type") == "tool_execution_end"]
    open_start = before[-1] if before else None
    # does a matching end exist after the gap start, and were there zero records of the same tool between?
    end_after = None
    if open_start:
        for _, r in recs[i:]:
            if r.get("type") == "tool_execution_end" and r.get("toolCallId") == open_start.get("toolCallId"):
                end_after = r; break
    inside_one_tool = bool(open_start and end_after)
    return round(g), before[-1].get("toolName") if before else None, inside_one_tool

for fname, exp_g, exp_inside in [
    ("del_20260902T230801Z_7c3c4a70.jsonl", 2640, True),
    ("del_20260903T004607Z_1238b870.jsonl", 1350, True),
    ("del_20260902T174738Z_e79dc2f2.jsonl", 300, True),
]:
    g, tool, inside = gap_analysis(fname)
    check(f"C3 {fname}", (g, tool, inside), (exp_g, "bash", exp_inside))

# ── C4: provider empty-error signature at end of three transcripts ──────────
for fname in ["del_20260903T033911Z_ddb256a0.jsonl",
              "del_20260902T230801Z_7c3c4a70.jsonl",
              "del_20260903T004607Z_1238b870.jsonl"]:
    last_msg_end = None
    for l in open(os.path.join(RUNS, fname)):
        if not l.strip(): continue
        try: raw = json.loads(json.loads(l).get("raw") or "{}")
        except Exception: continue
        if raw.get("type") == "message_end": last_msg_end = raw
    m = (last_msg_end or {}).get("message") or {}
    blocks = [b for b in (m.get("content") or []) if isinstance(b, dict)]
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
    check(f"C4 {fname}", (m.get("role"), m.get("stopReason"), text == ""), ("assistant", "error", True))
    errf = os.path.join(RUNS, fname.replace(".jsonl", ".stderr.log"))
    err_lines = [l for l in open(errf) if l.strip()]
    check(f"C4b {fname} stderr only model-discovery", all("[model-discovery]" in l for l in err_lines), True)

# ── C5: class-C receipts + parent model change + model usage ────────────────
r57 = json.load(open(os.path.join(RUNS, "del_20260903T112419Z_6d2c6164.json")))
r58 = json.load(open(os.path.join(RUNS, "del_20260903T121046Z_58e6f979.json")))
check("C5a #57 receipt", (r57["model"], r57["usage"]["turns"], r57["usage"]["output"], r57["exitCode"], r57["state"]),
      ("mac-m3/qwen3.8-flash@adaptive", 62, 50826, 143, "timed_out_hard"))
check("C5b #58 receipt", (r58["model"], r58["usage"]["turns"], r58["usage"]["output"], r58["state"]),
      ("mac-m3/qwen3.8-flash@adaptive", 24, 20112, "timed_out_hard"))
# last assistant message_end stop=aborted with thinking, for both
for fname in ["del_20260903T112419Z_6d2c6164.jsonl", "del_20260903T121046Z_58e6f979.jsonl"]:
    last = None
    for l in open(os.path.join(RUNS, fname)):
        if not l.strip(): continue
        try: raw = json.loads(json.loads(l).get("raw") or "{}")
        except Exception: continue
        if raw.get("type") == "message_end": last = raw
    m = (last or {}).get("message") or {}
    has_think = any(b.get("type") == "thinking" for b in (m.get("content") or []) if isinstance(b, dict))
    check(f"C5c {fname} final msg stop/has-thinking", (m.get("stopReason"), has_think), ("aborted", True))
mc = [json.loads(l) for l in open(PARENT) if json.loads(l).get("type") == "model_change"]
check("C5d parent model_change @11:14:28.904Z",
      (mc[-1]["timestamp"], mc[-1]["provider"], mc[-1]["modelId"]),
      ("2026-09-03T11:14:28.904Z", "mac-m3", "qwen3.8-flash@adaptive"))
models_used = {}
for cid, (ts, args) in calls.items():
    d = ((res_by_id.get(cid) or {}).get("message") or {}).get("details", {}) or {}
    mm = d.get("model")
    before_flash = ts < "2026-09-03T11:14:28"
    key = mm if before_flash else "POST-flash"
    models_used.setdefault(mm, 0); models_used[mm] += 1
check("C5e models by receipt (pre-flash vs post)", models_used,
      {"openai-codex/gpt-5.6-sol": 56, "mac-m3/qwen3.8-flash@adaptive": 2})

# ── C6: deployment lag ──────────────────────────────────────────────────────
head = json.loads(open(PARENT).readline())
check("C6a parent session head ts", head["timestamp"], "2026-09-02T17:18:47.672Z")
npm_time = json.loads(subprocess.check_output(["npm", "view", "@maheidem/pi-delegate", "time", "--json"]).decode())
check("C6b npm 0.1.3/0.1.4/0.1.5 publish", (npm_time["0.1.3"], npm_time["0.1.4"], npm_time["0.1.5"]),
      ("2026-09-02T19:58:43.092Z", "2026-09-02T20:43:08.704Z", "2026-09-03T05:31:07.784Z"))
for cid, (ts, args) in calls.items():
    msg = res_by_id.get(cid)
    if not msg: continue
    d = (msg.get("message") or {}).get("details", {}) or {}
    if d.get("runId") in ("del_20260903T112419Z_6d2c6164", "del_20260903T121046Z_58e6f979"):
        text = "".join(b.get("text", "") for b in (msg.get("message") or {}).get("content") or []
                       if isinstance(b, dict) and b.get("type") == "text")
        check(f"C6c '{ts}' result text says unknown failure", "error: unknown failure" in text, True)

# ── C6d: transcript writer format (0.1.0-era rawBase64 vs later raw) ─────
def fmt(fname):
    for l in open(os.path.join(RUNS, fname)):
        if not l.strip(): continue
        e = json.loads(l)
        return "rawBase64" if e.get("rawBase64") else ("raw" if e.get("raw") else "?")
    return "?"
check("C6d 174738 transcript format (0.1.0 era)", fmt("del_20260902T174738Z_e79dc2f2.jsonl"), "rawBase64")
check("C6e 230801 transcript format (post d270dcd)", fmt("del_20260902T230801Z_7c3c4a70.jsonl"), "raw")

# ── C7: code claims ─────────────────────────────────────────────────────────
def src_file(p): return open(os.path.join(SRC, p)).read()
runner, config, index = src_file("runner.ts"), src_file("config.ts"), src_file("index.ts")
check("C7a armInactivity reset by stdout chunks",
      ('this.inactivityTimer = setTimeout(() => this.cancel("timed_out_idle"), this.cfg.inactivityTimeoutMs)' in runner
       and "child.stdout?.on(\"data\", (chunk: Buffer) => this.onStdout(chunk))" in runner
       and "private noteActivity(): void {\n\t\tthis.armInactivity();\n\t}" in runner), True)
check("C7b hard/2 inactivity cap",
      "Math.min(\n\t\tbaseCfg.inactivityTimeoutMs,\n\t\tMath.max(1_000, Math.floor(hardMs / 2))," in config.replace("  ", "\t"), True)
check("C7c cancel(): abort → 2s → SIGTERM → grace → SIGKILL",
      ('{ type: "abort" }' in runner and "setTimeout(() => {" in runner
       and 'this.child.kill("SIGTERM")' in runner and 'this.child.kill("SIGKILL")' in runner), True)
check("C7d outcome handoff empty for non-success",
      'handoff: state === "succeeded" ? extra?.handoff ?? "" : ""' in runner, True)
check("C7e --no-session + --model req.parentModel",
      ('"--no-session"' in runner and '"--model", req.parentModel' in runner), True)
check("C7f DelegateParams = task/role/timeout only",
      ('task: Type.String({ minLength: 1 })' in index
       and 'role: Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("research")]))' in index
       and "model:" not in index[index.find("const DelegateParams"):index.find("pi.registerTool")]), True)
check("C7g 'unknown failure' builder",
      'const err = res.error ? `${res.error.code}: ${res.error.message}` : "unknown failure"' in index, True)

print("\n".join(results))
n_mis = sum(1 for r in results if r.startswith("[MISMATCH]"))
print(f"\n== {len(results) - n_mis}/{len(results)} checks OK, {n_mis} MISMATCH")
