#!/bin/bash
# promote_model.sh <org/model>  e.g. promote_model.sh unsloth/Qwen3.8-27B-GGUF
# Copies a model directory from slow array storage to fast NVMe cache.
set -euo pipefail
ORG="${1%%/*}"
MODEL="${1##*/}"
# Auto-detect storage paths (works on both gogo host and mounted container)
LIB=/opt/data/models/cold/hf/hub
SRC="$LIB/models--${ORG}--${MODEL}"
DST="/opt/data/models/hot/hf/hub/models--${ORG}--${MODEL}"
if [[ ! -d "$SRC" ]]; then
  echo "ERROR: not found on array: $SRC" >&2; exit 1
fi
mkdir -p /opt/data/models/hot/hf/hub
cp -a "$SRC/." "$DST/"
echo "Promoted: $ORG/$MODEL -> NVMe cache"
