#!/usr/bin/env bash
# Capture REAL delegate screens from a live pi TUI via tmux true-color -> PNG.
# Slice-compliant: panel shortcuts (d doctor) + slash reports + a real run.
#   ./capture-live.sh            idle/report screens (no model)
#   ./capture-live.sh run TASK   + live strip/peek/cancel frames (needs oMLX)
set -u
D="$(cd "$(dirname "$0")/.." && pwd)"; SHOTS="$D/evidence/shots"; mkdir -p "$SHOTS"
SESS="delcap-$$"; COL=94
cap(){ tmux capture-pane -e -p -t "$SESS" | sed -e 's/[[:space:]]*$//' > "/tmp/dl-$1.ans"; python3 "$D/capture/ansi_to_png.py" --file "/tmp/dl-$1.ans" "$SHOTS/$1.png"; echo "shot $1.png"; }
tmux kill-session -t "$SESS" 2>/dev/null
tmux new-session -d -s "$SESS" -x $COL -y 30 'pi'
sleep 5; tmux send-keys -t "$SESS" Enter; sleep 2

# Home dashboard (vendored SettingsPanel)
tmux send-keys -t "$SESS" '/delegate'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 3
cap S1-home
tmux send-keys -t "$SESS" Escape; sleep 1

# Report screens via slash (headless-reachable parity, printed to composer)
tmux send-keys -t "$SESS" '/delegate doctor'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2; cap S9-doctor
tmux send-keys -t "$SESS" '/delegate paths'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2; cap S9-paths

if [ "${1:-}" = run ]; then
  TASK="${2:-Run exactly one shell command: echo hello, then call handoff with the result. Be brief.}"
  tmux send-keys -t "$SESS" "/delegate run general $TASK"; tmux send-keys -t "$SESS" Enter
  for i in 01 02 03 04 05 06; do sleep 4; cap "S4-inline-$i"; done
  # detailed peek overlay over a finished/live run, then back to composer
  tmux send-keys -t "$SESS" '/delegate peek'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2; cap S6-peek; tmux send-keys -t "$SESS" 'q'; sleep 1
  # cancel-confirm: start another run, open panel, press x
  tmux send-keys -t "$SESS" "/delegate run general ${3:-Do nothing: sleep 20 seconds via bash, then handoff.}"; tmux send-keys -t "$SESS" Enter; sleep 6
  tmux send-keys -t "$SESS" '/delegate'; sleep 1; tmux send-keys -t "$SESS" Enter; sleep 2
  tmux send-keys -t "$SESS" 'x'; sleep 2; cap S8-cancel-confirm
  tmux send-keys -t "$SESS" Escape; sleep 1; tmux send-keys -t "$SESS" Escape; sleep 1
fi
tmux kill-session -t "$SESS" 2>/dev/null
echo "done -> $SHOTS"; ls -1 "$SHOTS"
