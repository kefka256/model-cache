#!/bin/bash
# promote_quant.sh <org/model> <quant-glob>
# Promotes only the blobs backing a specific quant (e.g. "Q4_K_M") to save NVMe space.
set -euo pipefail
ORG="${1%%/*}"
MODEL="${1##*/}"
PATTERN="${2:-}"
LIB=/opt/data/models/cold/hf/hub
SRC="$LIB/models--${ORG}--${MODEL}"
DST="/opt/data/models/hot/hf/hub/models--${ORG}--${MODEL}"
[[ -d "$SRC" ]] || { echo "ERROR: $SRC not found"; exit 1; }
mkdir -p "$DST/blobs" "$DST/snapshots" "$DST/refs"

found=0
while IFS= read -r -d '' snap; do
  found=1
  rel="${snap#$SRC/snapshots/}"
  target="$(readlink -f "$snap" 2>/dev/null || echo "$snap")"
  blobname="$(basename "$target")"
  mkdir -p "$DST/snapshots/$(dirname "$rel")"
  ln -sfn "../../blobs/$blobname" "$DST/snapshots/$rel"
  if [[ -f "$target" && ! -f "$DST/blobs/$blobname" ]]; then
    rsync -a --progress "$target" "$DST/blobs/$blobname"
    echo "  copied blob $blobname"
  fi
done < <(find "$SRC/snapshots" \( -type f -o -type l \) 2>/dev/null | grep -i "$PATTERN" | tr '\n' '\0')

cp -a "$SRC/refs/." "$DST/refs/" 2>/dev/null || true
[[ "$found" -eq 1 ]] && echo "Promoted quant '$PATTERN' for $ORG/$MODEL" || echo "WARN: no files matched '$PATTERN'"
