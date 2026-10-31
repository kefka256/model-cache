#!/bin/bash
# promote_hot.sh — pre-warm NVMe cache with daily-driver models.
# Reads one "org/model" per line from hotlist.txt (ignores blanks/#).
set -uo pipefail
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
log "Hot-model pre-warm started"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOTLIST="${HOTLIST:-$SCRIPT_DIR/../docs/models/hotlist.txt}"
[[ -f "$HOTLIST" ]] || { echo "No hotlist at $HOTLIST"; exit 0; }
while IFS= read -r line; do
  line="${line%%#*}"; line="$(echo "$line" | xargs)"
  [[ -z "$line" ]] && continue
  # Support optional quant glob: "org/model:QUANT" or "org/model QUANT"
  if [[ "$line" == *:* ]]; then
    model="${line%%:*}"
    quant="${line#*:}"
  else
    model="${line%% *}"
    quant="${line#* }"
  fi
  if [[ "$quant" == "$model" || -z "$quant" ]]; then
    log "Promoting (full): $model"
    "$SCRIPT_DIR/promote_model.sh" "$model" || log "WARN: failed $model"
  else
    log "Promoting (quant $quant): $model"
    "$SCRIPT_DIR/promote_quant.sh" "$model" "$quant" || log "WARN: failed $model $quant"
  fi
done < "$HOTLIST"
log "Hot-model pre-warm complete."
