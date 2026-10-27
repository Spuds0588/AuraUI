#!/usr/bin/env bash
# Scratch harness: run the one-question agent, then capture the overlay window's own pixels
# around the moment its card is withdrawn, so the card's position and the scrim's opacity can
# be read as numbers rather than opinions. Not part of the shipped examples.
#
#   bash examples/measure-exit.sh <tag>
set -u

TAG="${1:-run}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="/tmp/exit-$TAG"
rm -rf "$OUT"; mkdir -p "$OUT"

WINDOW=""
window_id() {
  xwininfo -root -tree 2>/dev/null | grep '"AuraUI"' | head -1 | awk '{print $1}'
}

# Finder: the window exists from app start, so look it up once.
for _ in $(seq 1 20); do
  WINDOW="$(window_id)"
  [ -n "$WINDOW" ] && break
  sleep 0.5
done
if [ -z "$WINDOW" ]; then
  echo "no AuraUI window found; is the app running?" >&2
  exit 1
fi
echo "window $WINDOW"

rm -f /tmp/exit-agent.log
setsid nohup node "$ROOT/examples/exit-demo.scratch.mjs" > /tmp/exit-agent.log 2>&1 </dev/null &
AGENT=$!
echo "agent $AGENT"

capture() {
  local name="$1"
  local state
  state="$(xwininfo -id "$WINDOW" 2>/dev/null | grep 'Map State' | awk '{print $3}')"
  if xwd -id "$WINDOW" -silent -out "$OUT/$name.xwd" 2>/dev/null; then
    printf '%s %s %s\n' "$(date +%s%3N)" "$name" "${state:-unknown}" >> "$OUT/timeline.txt"
  else
    printf '%s %s xwd-failed(%s)\n' "$(date +%s%3N)" "$name" "${state:-unknown}" >> "$OUT/timeline.txt"
  fi
}

# A frame of the card at rest, well past its arrival animation.
sleep 4
capture at-rest

# Every 300ms across the whole exit: park, settle-down, gone.
for i in $(seq 1 18); do
  sleep 0.3
  capture "after-$(printf '%02d' "$i")"
done

kill "$AGENT" 2>/dev/null
echo "=== agent schedule"
cat /tmp/exit-agent.log
echo "=== captures"
cat "$OUT/timeline.txt"
echo "=== readings"
for f in "$OUT"/*.xwd; do
  python3 "$ROOT/examples/xwd-card-check.py" "$f" --label "$(basename "$f" .xwd)"
done
