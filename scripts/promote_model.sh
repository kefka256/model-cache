#!/bin/bash
# promote_model.sh <org/model>  e.g. promote_model.sh unsloth/Qwen3.8-27B-GGUF
# Copies a model directory from slow array storage to fast NVMe cache.
set -euo pipefail
ORG="${1%%/*}"
MODEL="${1##*/}"
# Auto-detect storage paths (works on both gogo host and mounted container)
LIB=/opt/data/plugins/model-cache
SRC="$LIB/models--${ORG}--${MODEL}"
DST="/opt/data/plugins/model-cache/hot/models--${ORG}--${MODEL}"
if [[ ! -d "$SRC" ]]; then
  echo "ERROR: not found on array: $SRC" >&2; exit 1
fi
mkdir -p /opt/data/plugins/model-cache/hot
rsync -a --progress "$SRC/" "$DST/"
echo "Promoted: $ORG/$MODEL -> NVMe cache"
