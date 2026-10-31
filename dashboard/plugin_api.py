"""model-cache — backend for the Hermes desktop model cache tier manager.

Manages promotion/eviction of models between slow array storage (cold)
and fast NVMe (hot) via SSH to the gogo host.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

GOGO = "root@192.168.0.11"
COLD = "/mnt/user/AI/models"
HOT = "/mnt/cache/hf/hub"


def _ssh(cmd: str, timeout: int = 30) -> str:
    """Run a command on gogo via SSH, return stdout."""
    result = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
         "-o", "StrictHostKeyChecking=no", GOGO, cmd],
        capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr.strip() or "SSH failed")
    return result.stdout.strip()


@router.get("/status")
def get_status():
    """Cache and array space usage."""
    cold_du = _ssh(f"du -sh {COLD} 2>/dev/null | cut -f1")
    hot_du = _ssh(f"du -sh {HOT} 2>/dev/null | cut -f1")
    cache_df = _ssh("df -h /mnt/cache | tail -1")
    parts = cache_df.split()
    return {
        "cold_size": cold_du,
        "hot_size": hot_du,
        "cache_total": parts[1] if len(parts) > 1 else "?",
        "cache_used": parts[2] if len(parts) > 2 else "?",
        "cache_free": parts[3] if len(parts) > 3 else "?",
        "cache_pct": parts[4] if len(parts) > 4 else "?",
    }


@router.get("/cold")
def list_cold():
    """List models in cold storage (array)."""
    out = _ssh(f"ls {COLD} | grep '^models--'")
    models = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        name = line[len("models--"):].replace("--", "/", 1).replace("--", "-")
        # Get size
        size = _ssh(f"du -sh {COLD}/{line} 2>/dev/null | cut -f1")
        # Find gguf files
        ggufs = _ssh(f"find {COLD}/{line} -name '*.gguf' 2>/dev/null | sed 's|.*/||'")
        models.append({
            "dir": line,
            "name": name,
            "size": size,
            "ggufs": [g for g in ggufs.splitlines() if g.strip()],
        })
    return {"models": models}


@router.get("/hot")
def list_hot():
    """List models in hot cache (NVMe) with their quants."""
    out = _ssh(f"ls {HOT} 2>/dev/null | grep '^models--' || echo ''")
    models = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        name = line[len("models--"):].replace("--", "/", 1).replace("--", "-")
        size = _ssh(f"du -sh {HOT}/{line} 2>/dev/null | cut -f1")
        # List quants (gguf files in snapshots)
        quant_out = _ssh(f"find {HOT}/{line}/snapshots -name '*.gguf' 2>/dev/null | sed 's|.*/||' | sort -u || echo ''")
        quants = [q.strip() for q in quant_out.splitlines() if q.strip()]
        # Get size of each quant blob
        quant_sizes = {}
        for q in quants:
            qsize = _ssh(f"du -sh {HOT}/{line}/blobs/{q} 2>/dev/null | cut -f1")
            quant_sizes[q] = qsize
        models.append({"dir": line, "name": name, "size": size, "quants": quants, "quant_sizes": quant_sizes})
    return {"models": models}


class PromoteBody(BaseModel):
    model: str
    quant: Optional[str] = None


@router.post("/promote")
def promote(payload: PromoteBody):
    """Promote a model (or specific quant) from cold to hot."""
    if payload.quant:
        cmd = f"bash /mnt/user/AI/scripts/promote_quant.sh '{payload.model}' '{payload.quant}'"
    else:
        cmd = f"bash /mnt/user/AI/scripts/promote_model.sh '{payload.model}'"
    out = _ssh(cmd, timeout=1800)
    return {"ok": True, "output": out}


class EvictBody(BaseModel):
    model: str
    quant: Optional[str] = None


@router.post("/evict")
def evict(payload: EvictBody):
    """Evict a model or individual quant from hot cache. Syncs to cold first."""
    hot_check = _ssh(f"ls -d {HOT}/{payload.model} 2>/dev/null || echo 'NOT_FOUND'")
    if 'NOT_FOUND' in hot_check:
        return {"ok": False, "output": f"Model {payload.model} not found in hot cache"}

    if payload.quant:
        # Evict individual quant
        cold_quant = _ssh(f"ls {COLD}/{payload.model}/blobs/{payload.quant} 2>/dev/null || echo 'NOT_FOUND'")
        if 'NOT_FOUND' in cold_quant:
            _ssh(f"mkdir -p {COLD}/{payload.model}/blobs 2>/dev/null", timeout=30)
            _ssh(f"rsync -a {HOT}/{payload.model}/blobs/{payload.quant} {COLD}/{payload.model}/blobs/ 2>&1", timeout=300)
            snap_dir = _ssh(f"ls -d {HOT}/{payload.model}/snapshots/*/ 2>/dev/null | head -1").strip()
            if snap_dir:
                snap_name = snap_dir.rstrip('/').split('/')[-1]
                _ssh(f"mkdir -p {COLD}/{payload.model}/snapshots/{snap_name} 2>/dev/null; ln -sf ../../blobs/{payload.quant} {COLD}/{payload.model}/snapshots/{snap_name}/{payload.quant} 2>/dev/null", timeout=30)
        _ssh(f"rm -f {HOT}/{payload.model}/blobs/{payload.quant}")
        _ssh(f"find {HOT}/{payload.model}/snapshots -name '{payload.quant}' -delete 2>/dev/null")
        remaining = _ssh(f"find {HOT}/{payload.model}/snapshots -name '*.gguf' 2>/dev/null | wc -l")
        if remaining.strip() == '0':
            _ssh(f"rm -rf {HOT}/{payload.model}")
            return {"ok": True, "output": f"Evicted {payload.quant}. No quants remain — removed model directory."}
        return {"ok": True, "output": f"Evicted {payload.quant}. {remaining.strip()} quant(s) remain."}
    else:
        # Evict entire model
        cold_check = _ssh(f"ls -d {COLD}/{payload.model} 2>/dev/null || echo 'NOT_FOUND'")
        if 'NOT_FOUND' in cold_check:
            sync_out = _ssh(f"rsync -a {HOT}/{payload.model}/ {COLD}/{payload.model}/ 2>&1 | tail -3", timeout=600)
            verify = _ssh(f"ls -d {COLD}/{payload.model} 2>/dev/null || echo 'NOT_FOUND'")
            if 'NOT_FOUND' in verify:
                return {"ok": False, "output": f"Sync to cold failed, aborting evict.\n{sync_out}"}
        out = _ssh(f"rm -rf {HOT}/{payload.model} && echo 'Evicted {payload.model}'")
        return {"ok": True, "output": f"Cold verified. {out}"}


@router.get("/hotlist")
def get_hotlist():
    """Read the hotlist file."""
    out = _ssh("cat /mnt/user/AI/docs/models/hotlist.txt 2>/dev/null || echo ''")
    return {"content": out}


class HotlistBody(BaseModel):
    content: str


@router.put("/hotlist")
def update_hotlist(payload: HotlistBody):
    """Update the hotlist file."""
    # Write via SSH using heredoc
    escaped = payload.content.replace("'", "'\\''")
    _ssh(f"cat > /mnt/user/AI/docs/models/hotlist.txt << 'HOTLIST_EOF'\n{payload.content}\nHOTLIST_EOF")
    return {"ok": True}


@router.post("/evict-stale")
def evict_stale():
    """Run the full evict script (sync back + evict idle >7d)."""
    out = _ssh("bash /mnt/user/AI/scripts/evict_models.sh", timeout=300)
    return {"ok": True, "output": out}


@router.post("/promote-hot")
def promote_hot():
    """Run the full promote_hot script (pre-warm all hotlist entries)."""
    out = _ssh("bash /mnt/user/AI/scripts/promote_hot.sh", timeout=600)
    return {"ok": True, "output": out}
