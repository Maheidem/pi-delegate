#!/usr/bin/env bash
# Stitch numbered frames to a GIF: ./to-gif.sh <glob> <out.gif> [fps]
set -u; G="${1:-evidence/shots/S4-inline-*.png}"; O="${2:-evidence/demo.gif}"; F="${3:-2}"
ffmpeg -y -framerate "$F" -pattern_type glob -i "$G" -vf "pad=ceil(iw/2)*2:ceil(ih/2)*2" "$O" >/dev/null 2>&1 && echo "gif $O" || echo "ffmpeg stitch failed (check frames)"
