import logging
import shutil
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

log = logging.getLogger(__name__)
router = APIRouter()

HOT = "/opt/data/models/hot/hf/hub"
COLD = "/opt/data/models/cold/hf/hub"


def _local(cmd: str, timeout: int = 30) -> str:
    """Run a command locally, return stdout."""
    import subprocess, shlex, os
    try:
        result = subprocess.run(
            shlex.split(cmd),
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=os.getcwd(),
        )
        if result.returncode != 0:
            log.error(f"Command failed: {cmd} -> {result.stderr}")
            return result.stderr.strip()
        return result.stdout.strip()
    except subprocess.TimeoutExpired as e:
        log.error(f"Command timed out: {cmd}")
        return e.stderr.strip() if e.stderr else ""


def _parse_model_id(model: str) -> tuple[str, str]:
    """Convert 'models--org--model' -> ('org', 'model'). Accepts 'org/model' too."""
    if model.startswith("models--"):
        model = model[len("models--"):].replace("--", "/", 1).replace("--", "-")
    if "/" not in model:
        raise ValueError(f"Invalid model id: {model}")
    org, model_name = model.split("/", 1)
    return org, model_name


def _promote_model(org: str, model_name: str) -> str:
    """Copy entire model directory from cold to hot storage."""
    src = Path(COLD) / f"models--{org}--{model_name}"
    dst = Path(HOT) / f"models--{org}--{model_name}"
    
    if not src.exists():
        return f"ERROR: not found on array: {src}"
    
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, dirs_exist_ok=True)
    return f"Promoted: {org}/{model_name} -> NVMe cache"


def _promote_quant(org: str, model_name: str, pattern: str) -> str:
    """Promote only blobs matching a specific quant pattern."""
    src = Path(COLD) / f"models--{org}--{model_name}"
    dst = Path(HOT) / f"models--{org}--{model_name}"
    
    if not src.exists():
        return f"ERROR: not found on array: {src}"
    
    dst.mkdir(parents=True, exist_ok=True)
    (dst / "blobs").mkdir(exist_ok=True)
    (dst / "snapshots").mkdir(exist_ok=True)
    (dst / "refs").mkdir(exist_ok=True)
    
    found = False
    snapshots_src = src / "snapshots"
    if not snapshots_src.exists():
        return f"WARN: no snapshots in {src}"
    
    pattern_lower = pattern.lower()
    for snap in snapshots_src.rglob("*"):
        if not (snap.is_file() or snap.is_symlink()):
            continue
        if pattern_lower not in snap.name.lower():
            continue
        
        found = True
        rel = snap.relative_to(snapshots_src)
        target = snap.resolve() if snap.is_symlink() else snap
        blobname = target.name
        
        dst_snap = dst / "snapshots" / rel
        dst_snap.parent.mkdir(parents=True, exist_ok=True)
        
        # Create symlink to blob
        try:
            dst_snap.unlink(missing_ok=True)
        except OSError:
            pass
        dst_snap.symlink_to(f"../../blobs/{blobname}")
        
        # Copy blob if not already present
        dst_blob = dst / "blobs" / blobname
        if not dst_blob.exists():
            shutil.copy2(target, dst_blob)
    
    # Copy refs
    refs_src = src / "refs"
    if refs_src.exists():
        for ref in refs_src.rglob("*"):
            if ref.is_file():
                rel = ref.relative_to(refs_src)
                dst_ref = dst / "refs" / rel
                dst_ref.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ref, dst_ref)
    
    if found:
        return f"Promoted quant '{pattern}' for {org}/{model_name}"
    return f"WARN: no files matched '{pattern}'"


class PromoteBody(BaseModel):
    model: str
    quant: Optional[str] = None
    action: str = "promote"  # "promote" = full model; if quant provided, promotes only that quant


class EvictBody(BaseModel):
    model: str
    quant: Optional[str] = None
    action: str = "evict"  # "evict" = full model; if quant provided, evicts only that quant


def _evict_model(org: str, model_name: str) -> str:
    """Remove entire model directory from hot storage (after syncing back to cold)."""
    src = Path(HOT) / f"models--{org}--{model_name}"
    
    if not src.exists():
        return f"ERROR: not found in cache: {src}"
    
    # Sync back to cold first (preserve any new downloads)
    dst = Path(COLD) / f"models--{org}--{model_name}"
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst, dirs_exist_ok=True)
    
    shutil.rmtree(src)
    return f"Evicted: {org}/{model_name} (synced back to array)"


def _evict_quant(org: str, model_name: str, pattern: str) -> str:
    """Remove only blobs matching a specific quant pattern from hot storage."""
    src = Path(HOT) / f"models--{org}--{model_name}"
    
    if not src.exists():
        return f"ERROR: not found in cache: {src}"
    
    snapshots_src = src / "snapshots"
    if not snapshots_src.exists():
        return f"WARN: no snapshots in {src}"
    
    found = False
    blobs_dir = src / "blobs"
    pattern_lower = pattern.lower()
    
    for snap in snapshots_src.rglob("*"):
        if not (snap.is_file() or snap.is_symlink()):
            continue
        if pattern_lower not in snap.name.lower():
            continue
        
        found = True
        target = snap.resolve() if snap.is_symlink() else snap
        blobname = target.name
        
        # Remove symlink
        try:
            snap.unlink()
        except OSError:
            pass
        
        # Remove blob if no other snapshots reference it
        if blobs_dir.exists():
            blob_path = blobs_dir / blobname
            if blob_path.exists():
                # Check if any other snapshot references this blob
                still_referenced = False
                for other in snapshots_src.rglob("*"):
                    if other.is_symlink() and other != snap:
                        try:
                            if other.resolve() == target:
                                still_referenced = True
                                break
                        except OSError:
                            pass
                if not still_referenced:
                    try:
                        blob_path.unlink()
                    except OSError:
                        pass
    
    if found:
        return f"Evicted quant '{pattern}' for {org}/{model_name}"
    return f"WARN: no files matched '{pattern}'"


@router.get("/status")
def status():
    out = _local(f"ls {COLD} 2>/dev/null | wc -l || echo '0'")
    cold = int(out.strip() or 0)
    out = _local(f"ls {HOT} 2>/dev/null | wc -l || echo '0'")
    hot = int(out.strip() or 0)
    free = _local(f"du -sh /opt/data/models 2>/dev/null | cut -f1 || echo '?'")
    pct = _local(r"df -h /opt/data/models 2>/dev/null | awk 'NR==2 {print \$5}' || echo '?'")
    return JSONResponse({
        "cold_size": f"{cold} models",
        "hot_size": f"{hot} models",
        "cache_free": free,
        "cache_pct": pct,
    })


@router.get("/cold")
def cold():
    out = _local(f"ls {COLD} 2>/dev/null | grep '^models--' || echo ''")
    models = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        name = line[len("models--"):].replace("--", "/", 1).replace("--", "-")
        size = _local(f"du -sh {COLD}/{line} 2>/dev/null | cut -f1")
        models.append({"dir": line, "name": name, "size": size})
    return JSONResponse({"models": models})


@router.get("/hot")
def hot():
    out = _local(f"ls {HOT} 2>/dev/null | grep '^models--' || echo ''")
    models = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        name = line[len("models--"):].replace("--", "/", 1).replace("--", "-")
        size = _local(f"du -sh {HOT}/{line} 2>/dev/null | cut -f1")
        quant_out = _local(f"find {HOT}/{line}/snapshots -name '*.gguf' 2>/dev/null | sed 's|.*/||' | sort -u || echo ''")
        quants = [q.strip() for q in quant_out.splitlines() if q.strip()]
        quant_sizes = {}
        for q in quants:
            qpath = _local(f"find {HOT}/{line}/snapshots -name '{q}' 2>/dev/null | head -1")
            if qpath:
                quant_sizes[q] = _local(f"du -shL '{qpath}' 2>/dev/null | cut -f1")
            else:
                quant_sizes[q] = "?"
        models.append({"dir": line, "name": name, "size": size, "quants": quants, "quant_sizes": quant_sizes})
    return JSONResponse({"models": models})


@router.post("/promote")
def promote(body: PromoteBody):
    try:
        org, model_name = _parse_model_id(body.model)
    except ValueError as e:
        return JSONResponse({"ok": False, "output": str(e)}, status_code=400)
    
    if body.quant:
        out = _promote_quant(org, model_name, body.quant)
    else:
        out = _promote_model(org, model_name)
    return JSONResponse({"ok": True, "output": out})


@router.post("/evict")
def evict(body: EvictBody):
    try:
        org, model_name = _parse_model_id(body.model)
    except ValueError as e:
        return JSONResponse({"ok": False, "output": str(e)}, status_code=400)
    
    if body.quant:
        out = _evict_quant(org, model_name, body.quant)
    else:
        out = _evict_model(org, model_name)
    return JSONResponse({"ok": True, "output": out})