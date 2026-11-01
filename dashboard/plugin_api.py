import logging
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
log = logging.getLogger(__name__)

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

def _local_promote(model: str, quant: Optional[str] = None) -> str:
    if quant:
        return _local(f"bash /opt/data/plugins/model-cache/scripts/promote_quant.sh '{model}' '{quant}'")
    else:
        return _local(f"bash /opt/data/plugins/model-cache/scripts/promote_model.sh '{model}'")

def _local_evict(model: str, quant: Optional[str] = None) -> str:
    if quant:
        return _local(f"bash /opt/data/plugins/model-cache/scripts/evict_models.sh '{model}' '{quant}'")
    else:
        return _local(f"bash /opt/data/plugins/model-cache/scripts/evict_models.sh '{model}'")

@app.get("/status")
def status():
    out = _local(f"ls {COLD} 2>/dev/null | wc -l || echo '0'")
    cold = int(out.strip() or 0)
    out = _local(f"ls {HOT} 2>/dev/null | wc -l || echo '0'")
    hot = int(out.strip() or 0)
    free = _local(f"du -sh /opt/data/models 2>/dev/null | cut -f1 || echo '?')")
    pct = _local(f"df -h /opt/data/models 2>/dev/null | awk 'NR==2 {print $5}' || echo '?')")
    return JSONResponse({
        "cold_size": f"{cold} models",
        "hot_size": f"{hot} models",
        "cache_free": free,
        "cache_pct": pct,
    })

@app.get("/cold")
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

@app.get("/hot")
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

class PromoteBody(BaseModel):
    model: str
    quant: Optional[str] = None

@app.post("/promote")
def promote(body: PromoteBody):
    out = _local_promote(body.model, body.quant)
    return JSONResponse({"ok": True, "output": out})

@app.post("/evict")
def evict(body: PromoteBody):
    out = _local_evict(body.model, body.quant)
    return JSONResponse({"ok": True, "output": out})
