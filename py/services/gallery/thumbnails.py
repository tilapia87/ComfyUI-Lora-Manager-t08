"""Downscaled thumbnails for the gallery grid.

A browser page of 40 images used to request 40 full-resolution outputs; a single
4K PNG can be tens of megabytes, so a library page could pull hundreds of
megabytes just to draw a 240px card. This service keeps a disk cache of small
WebP thumbnails, which is what the grid loads; the full image is still what the
viewer shows when a card is opened.

Nothing here is required for correctness: any failure (no Pillow, an unreadable
file, an unwritable cache) returns ``None`` and the caller serves the original.
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import threading
import time
from typing import Optional

logger = logging.getLogger(__name__)

DEFAULT_THUMBNAIL_SIZE = 512
MIN_THUMBNAIL_SIZE = 64
MAX_THUMBNAIL_SIZE = 2048
_QUALITY = 82
# The cache is disposable: prune the oldest entries once it grows past this.
_MAX_ENTRIES = 4000
_PRUNE_EVERY = 250

_ENV_CACHE_DIR = "LORA_MANAGER_THUMBNAIL_DIR"


def _clamp_size(value: int) -> int:
    try:
        size = int(value)
    except (TypeError, ValueError):
        return DEFAULT_THUMBNAIL_SIZE
    return max(MIN_THUMBNAIL_SIZE, min(MAX_THUMBNAIL_SIZE, size))


class ThumbnailService:
    """Disk-backed cache of downscaled WebP thumbnails."""

    _instance: Optional["ThumbnailService"] = None
    _instance_lock = threading.Lock()

    def __init__(self, cache_dir: Optional[str] = None) -> None:
        self._cache_dir = cache_dir
        self._lock = threading.Lock()
        self._writes = 0

    @classmethod
    def get_instance(cls) -> "ThumbnailService":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Drop the process-wide instance. Used by tests."""
        with cls._instance_lock:
            cls._instance = None

    # ------------------------------------------------------------------ paths

    def cache_root(self) -> str:
        """Directory holding the cached thumbnails."""
        if self._cache_dir:
            root = self._cache_dir
        elif os.environ.get(_ENV_CACHE_DIR):
            root = os.environ[_ENV_CACHE_DIR]
        else:
            root = os.path.join(tempfile.gettempdir(), "comfyui-lora-manager", "gallery-thumbs")
        os.makedirs(root, exist_ok=True)
        return root

    def _target_path(self, source_path: str, size: int) -> str:
        try:
            stat = os.stat(source_path)
            stamp = f"{stat.st_mtime_ns}:{stat.st_size}"
        except OSError:
            stamp = "missing"
        digest = hashlib.sha1(f"{source_path}|{stamp}|{size}".encode("utf-8", "surrogatepass")).hexdigest()
        root = self.cache_root()
        shard = os.path.join(root, digest[:2])
        os.makedirs(shard, exist_ok=True)
        return os.path.join(shard, f"{digest}.webp")

    # --------------------------------------------------------------- generate

    def get(self, source_path: str, size: int = DEFAULT_THUMBNAIL_SIZE) -> Optional[str]:
        """Return the path of a cached thumbnail, generating it if needed."""
        if not source_path or not os.path.isfile(source_path):
            return None
        size = _clamp_size(size)
        try:
            target = self._target_path(source_path, size)
        except OSError as exc:
            logger.debug("Thumbnail cache directory unavailable: %s", exc)
            return None

        if os.path.isfile(target) and os.path.getsize(target) > 0:
            return target

        try:
            encoded = self._encode(source_path, size)
        except Exception as exc:  # Pillow missing or a broken image
            logger.debug("Thumbnail generation failed for %s: %s", source_path, exc)
            return None
        if not encoded:
            return None

        # Write through a temporary file so a concurrent reader never sees a
        # half-written thumbnail.
        try:
            temp_path = f"{target}.{os.getpid()}.tmp"
            with open(temp_path, "wb") as handle:
                handle.write(encoded)
            os.replace(temp_path, target)
        except OSError as exc:
            logger.debug("Thumbnail write failed for %s: %s", target, exc)
            return None

        self._maybe_prune()
        return target

    @staticmethod
    def _encode(source_path: str, size: int) -> Optional[bytes]:
        from io import BytesIO

        from PIL import Image

        with Image.open(source_path) as image:
            # JPEGs can be decoded at a reduced scale, which is much cheaper than
            # decoding 4K and then shrinking it.
            try:
                image.draft("RGB", (size, size))
            except Exception:  # pragma: no cover - format dependent
                pass
            if image.mode in ("RGBA", "LA", "P"):
                image = image.convert("RGBA")
                background = Image.new("RGB", image.size, (255, 255, 255))
                background.paste(image, mask=image.split()[-1])
                image = background
            elif image.mode != "RGB":
                image = image.convert("RGB")
            image.thumbnail((size, size), Image.Resampling.LANCZOS)
            buffer = BytesIO()
            image.save(buffer, format="WEBP", quality=_QUALITY, method=4)
            return buffer.getvalue()

    # ------------------------------------------------------------------ prune

    def _maybe_prune(self) -> None:
        with self._lock:
            self._writes += 1
            should_prune = self._writes % _PRUNE_EVERY == 0
        if not should_prune:
            return
        try:
            self._prune()
        except Exception as exc:  # pragma: no cover - best effort
            logger.debug("Thumbnail prune failed: %s", exc)

    def _prune(self) -> None:
        root = self.cache_root()
        entries = []
        for shard in os.scandir(root):
            if not shard.is_dir():
                continue
            for entry in os.scandir(shard.path):
                if entry.name.endswith(".webp"):
                    try:
                        entries.append((entry.stat().st_mtime, entry.path))
                    except OSError:
                        continue
        if len(entries) <= _MAX_ENTRIES:
            return
        entries.sort()
        for _mtime, path in entries[: len(entries) - _MAX_ENTRIES]:
            try:
                os.remove(path)
            except OSError:
                continue
        logger.debug("Pruned %d stale gallery thumbnails", len(entries) - _MAX_ENTRIES)


def thumbnail_for(source_path: str, size: int = DEFAULT_THUMBNAIL_SIZE) -> Optional[str]:
    """Module-level convenience wrapper around the process-wide cache."""
    return ThumbnailService.get_instance().get(source_path, size)


def thumbnail_cache_size() -> int:
    """Number of cached thumbnails (diagnostics and tests)."""
    root = ThumbnailService.get_instance().cache_root()
    count = 0
    for shard in os.scandir(root):
        if shard.is_dir():
            count += sum(1 for entry in os.scandir(shard.path) if entry.name.endswith(".webp"))
    return count

def cache_stats(service: Optional[ThumbnailService] = None) -> dict:
    """Count and byte size of the thumbnail cache."""
    instance = service or ThumbnailService.get_instance()
    root = instance.cache_root()
    count = 0
    total_bytes = 0
    try:
        shards = [entry for entry in os.scandir(root) if entry.is_dir()]
    except OSError:
        shards = []
    for shard in shards:
        try:
            for entry in os.scandir(shard.path):
                if not entry.name.endswith(".webp"):
                    continue
                try:
                    total_bytes += entry.stat().st_size
                    count += 1
                except OSError:
                    continue
        except OSError:
            continue
    return {"count": count, "bytes": total_bytes, "directory": root}


def clear_cache(service: Optional[ThumbnailService] = None) -> dict:
    """Delete every cached thumbnail. Returns what was removed."""
    instance = service or ThumbnailService.get_instance()
    before = cache_stats(instance)
    root = before["directory"]
    removed = 0
    try:
        shards = [entry for entry in os.scandir(root) if entry.is_dir()]
    except OSError:
        shards = []
    for shard in shards:
        try:
            for entry in os.scandir(shard.path):
                if not entry.name.endswith(".webp"):
                    continue
                try:
                    os.remove(entry.path)
                    removed += 1
                except OSError:
                    continue
        except OSError:
            continue
    return {"removed": removed, "count": 0, "bytes": 0, "directory": root}
