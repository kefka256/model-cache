#!/bin/bash
# evict_models.sh — daily cron
# Syncs any NVMe-cached model back to the array (so new downloads become
# part of the permanent library), then evicts models not accessed in 7 days.
set -euo pipefail
CACHE="/opt/data/plugins/model-cache"
LIB="/opt/data/plugins/model-cache-cold"
DAYS="${EVICT_DAYS:-7}"

for d in "$CACHE"/models--*; do
  [[ -d "$d" ]] || continue
  name="$(basename "$d")"
  # Sync back to array (idempotent; preserves new downloads into library)
  rsync -a "$d/" "$LIB/$name/"
  # Evict if untouched for N days
  if [[ -n "$(find "$d" -type f -atime +"$DAYS" -print -quit)" ]]; then
    echo "Evicting $name (unused >${DAYS}d)"
    rm -rf "$d"
  fi
done
echo "Eviction pass complete."
