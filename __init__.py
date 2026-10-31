"""Hermes Model Cache — unified plugin package.

Tiered model storage manager: promotes models from array (cold) to NVMe (hot),
evicts stale ones, manages the hotlist, and shows space usage. The Python half
lives in ``dashboard/`` (FastAPI router mounted at ``/api/plugins/model-cache/``)
and the desktop renderer half in ``desktop/plugin.js`` (runtime ESM loaded by
Hermes Desktop). Neither half registers core agent tools, hooks, or middleware.
"""


def register(ctx) -> None:
    """No-op registration for the capability probe."""
    return None
