"""LoRA hash -> preview image, for the gallery statistics table.

The gallery ranking stores the LoRA hash it resolved during the scan, so the
statistics table can show the same thumbnail the LoRA page shows. This module
builds that lookup from the scanner cache; it is best-effort by design, because
a cold or missing cache must never fail a statistics request.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)


def build_lora_preview_index(scanner_cache: Any) -> Dict[str, str]:
    """Map every local LoRA's sha256 to its static preview URL.

    Items without a hash or without a preview are skipped. When two items share
    a hash the first preview wins: the ranking only needs *a* thumbnail.
    """
    index: Dict[str, str] = {}
    try:
        raw = getattr(scanner_cache, "raw_data", None) or []
    except Exception:  # pragma: no cover - defensive
        return index

    # Imported lazily: this module is imported by services that must stay
    # importable before ComfyUI's config is fully wired (see gallery_service).
    from ...config import config

    for item in raw:
        if not isinstance(item, dict):
            continue
        digest = item.get("sha256")
        preview = item.get("preview_url")
        if (
            not isinstance(digest, str)
            or not digest
            or not isinstance(preview, str)
            or not preview
        ):
            continue
        if digest not in index:
            index[digest] = config.get_preview_static_url(preview)
    return index
