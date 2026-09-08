#!/usr/bin/env bash
# capture-isolated.sh — LIVE capture of the NEW delegate UI in an ISOLATED
# pi (PI_CODING_AGENT_DIR copy with the published delegate stripped + the dev
# source loaded project-locally). Does NOT touch the live install. Produces
# true-color PNGs (tmux capture-pane -e), a live demo.gif, and real-session.html.
set -u
D="$(cd "$(dirname "$0")/.." && pwd)"; SRC="$D/../.."  # custom-extensions/delegate
DELEGATE_SRC="$(cd "$D/../.." && pwd)"  # delegate dir
SHOTS="$D/evidence/shots"; mkdir -p "$SHOTS"
LIVE_CFG="$HOME/.pi/agent"
CFG="$(mktemp -d)"; WS="$(mktemp -d)"
cp -R "$LIVE_CFG"/. "$CFG"/ 2>/dev/null
python3 - "$CFG/settings.json" <<'PY'
import json,sys
try:
  s=json.load(open(sys.argv[1]))
except Exception:
  sys.exit(0)
if isinstance(s.get("packages"),list):
  s["packages"]=[p for p in s["packages"] if "delegate" not in str(p)]
open(sys.argv[1],"w").write(json.dumps(s,indent=2))
PY
mkdir -p "$WS/.pi/extensions"; cp -R "$DELEGATE_SRC" "$WS/.pi/extensions/delegate"
rm -rf "$WS/.pi/extensions/delegate/.planning" "$WS/.pi/extensions/delegate/tests"
SESS="deliso-$$"; COL=94
export PI_CODING_AGENT_DIR="$CFG"
cap(){ tmux capture-pane -e -p -t "$SESS" | sed -e 's/[[:space:]]*$//' > "/tmp/is-$1.ans"; python3 "$D/capture/ansi_to_png.py" --file "/tmp/is-$1.ans" "$SHOTS/$1.png"; echo "shot $1.png"; }
tmux kill-session -t "$SESS" 2>/dev/null
tmux new-session -d -s "$SESS" -x $COL -y 30 "cd '$WS' && PI_CODING_AGENT_DIR='$CFG' pi --approve"
sleep 6; tmux send-keys -t "$SESS" Enter 2>/dev/null; sleep 2

tmux send-keys -t "$SESS" '/delegate'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 3
cap S1-home-live
tmux send-keys -t "$SESS" Escape; sleep 1
tmux send-keys -t "$SESS" '/delegate doctor'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2; cap S9-doctor-live
tmux send-keys -t "$SESS" '/delegate paths'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2; cap S9-paths-live

if [ "${1:-}" = run ]; then
  T="${2:-Use one bash tool call to run: echo hello. Then call handoff with the literal output.}"
  tmux send-keys -t "$SESS" "/delegate run general $T"; tmux send-keys -t "$SESS" Enter
  for i in 01 02 03 04 05 06; do sleep 4; cap "live-inline-$i"; done
  tmux send-keys -t "$SESS" '/delegate peek'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2; cap S6-peek-live; tmux send-keys -t "$SESS" 'q'; sleep 1
  # cancel-confirm on a running task
  tmux send-keys -t "$SESS" '/delegate run general Use bash to run: sleep 25. Then handoff.'; tmux send-keys -t "$SESS" Enter; sleep 8
  tmux send-keys -t "$SESS" '/delegate'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2
  tmux send-keys -t "$SESS" 'x'; sleep 2; cap S8-cancel-confirm-live
  tmux send-keys -t "$SESS" Escape; sleep 1; tmux send-keys -t "$SESS" Escape; sleep 1
fi
tmux kill-session -t "$SESS" 2>/dev/null

# locate the real session jsonl and export to HTML
SESSFILE="$(find "$WS/.pi" "$CFG" -name '*.jsonl' -type f 2>/dev/null | xargs -I{} sh -c 'echo "$(wc -l < "{}") {}"' 2>/dev/null | sort -rn | head -1 | awk '{print $2}')"
if [ -n "${SESSFILE:-}" ]; then
  pi --export "$SESSFILE" "$D/evidence/real-session.html" >/dev/null 2>&1 && echo "real-session.html <- $SESSFILE" || echo "export failed for $SESSFILE"
else
  echo "no session jsonl found"
fi
echo "done -> $SHOTS"; ls -1 "$SHOTS"
