#!/usr/bin/env bash
# Extract a scroll-scrub frame sequence for the landing CinematicScroll band.
#
#   scripts/cinematic-frames.sh <input-video> [frame-count] [width]
#
# Writes frontend/public/cinematic/frame_0001.webp … + manifest.json.
# Defaults: 96 frames at 1280px wide (~3-5 MB total at q72).
set -euo pipefail

IN="${1:?usage: cinematic-frames.sh <video> [count] [width]}"
COUNT="${2:-96}"
WIDTH="${3:-1280}"
OUT="$(dirname "$0")/../frontend/public/cinematic"

mkdir -p "$OUT"
rm -f "$OUT"/frame_*.webp "$OUT"/manifest.json

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")
FPS=$(python3 -c "print($COUNT / float($DUR))")

ffmpeg -hide_banner -loglevel error -y -i "$IN" \
  -vf "fps=${FPS},scale=${WIDTH}:-2" -frames:v "$COUNT" \
  -c:v libwebp -quality 72 "$OUT/frame_%04d.webp"

N=$(ls "$OUT"/frame_*.webp | wc -l | tr -d ' ')
read -r W H < <(ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height -of csv=p=0 "$OUT/frame_0001.webp" | tr ',' ' ')

printf '{"count": %s, "width": %s, "height": %s}\n' "$N" "$W" "$H" >"$OUT/manifest.json"

TOTAL=$(du -sh "$OUT" | cut -f1)
echo "wrote $N frames (${W}x${H}) to $OUT ($TOTAL)"
