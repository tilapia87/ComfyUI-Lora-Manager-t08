"""The gallery service: scanning, ratings, and preference statistics.

Everything the gallery needs that is not persistence lives here. The service is
resolved lazily on the first request (routes register before the event loop's
startup hooks run), so nothing in here may touch ComfyUI at import time.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from ...utils.artist_tags import load_gallery_artist_index
from ..settings_manager import get_settings_manager
from ..websocket_manager import ws_manager
from .gallery_cache import GalleryCache, VALID_RATINGS
from .gallery_indexer import (
    build_lora_index,
    iter_image_paths,
    parse_image,
    resolve_output_dir,
)

logger = logging.getLogger(__name__)

# How often the scan reports progress while the blocking walk runs.
_PROGRESS_INTERVAL_SECONDS = 0.5

_STATS_SORT_KEYS = {
    "net": lambda item: item["net"],
    "likes": lambda item: item["likes"],
    "dislikes": lambda item: item["dislikes"],
    "total": lambda item: item["total"],
    "ratio": lambda item: (item["like_ratio"] if item["like_ratio"] is not None else -1.0),
}


def _is_within_root(path: str, root: str) -> bool:
    """Containment check on business paths (``abspath``, never ``realpath``)."""
    if not path or not root:
        return False
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(root)]) == os.path.abspath(root)
    except ValueError:
        # Different drives on Windows.
        return False


class GalleryService:
    """Owns the gallery database, the scan job, and the answering of queries."""

    _instance: Optional["GalleryService"] = None
    _instance_lock = threading.Lock()

    def __init__(self, cache: Optional[GalleryCache] = None) -> None:
        self.cache = cache or GalleryCache.get_instance()
        self._task: Optional[asyncio.Task] = None
        self._status: Dict[str, Any] = self._idle_status()

    @classmethod
    async def get_instance(cls) -> "GalleryService":
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

    # ------------------------------------------------------------------ state

    @staticmethod
    def _idle_status() -> Dict[str, Any]:
        return {
            "running": False,
            "stage": "idle",
            "progress": 100,
            "total": 0,
            "indexed": 0,
            "added": 0,
            "updated": 0,
            "removed": 0,
            "failed": 0,
            "root": "",
            "root_source": "unset",
            "last_run": None,
            "error": None,
        }

    def get_status(self) -> Dict[str, Any]:
        return dict(self._status)

    def is_running(self) -> bool:
        return bool(self._status.get("running"))

    async def _broadcast(self) -> None:
        try:
            await ws_manager.broadcast(
                {"type": "gallery_index_progress", **self.get_status()}
            )
        except Exception as exc:  # pragma: no cover - best effort
            logger.debug("Gallery progress broadcast failed: %s", exc)

    # ------------------------------------------------------------------- scan

    async def start_index(self, *, force: bool = False) -> Dict[str, Any]:
        """Start a background scan. Returns whether one was actually started."""
        if self.is_running():
            return {"started": False, "reason": "already_running"}
        self._status = self._idle_status()
        self._status.update({"running": True, "stage": "walking", "progress": 0})
        self._task = asyncio.create_task(self._run_index(force=force), name="gallery_index")
        return {"started": True}

    async def _run_index(self, *, force: bool) -> None:
        settings = get_settings_manager()
        root, source = resolve_output_dir(settings)
        self._status.update(
            {"root": root, "root_source": source, "stage": "walking", "progress": 0}
        )
        await self._broadcast()

        if not root or not os.path.isdir(root):
            self._status.update(
                {
                    "running": False,
                    "stage": "error",
                    "progress": 100,
                    "error": "output_directory_not_found",
                    "last_run": time.time(),
                }
            )
            await self._broadcast()
            logger.warning("Gallery scan aborted: no output directory (source=%s)", source)
            return

        recursive = bool(settings.get("gallery_recursive", True))

        poller = asyncio.create_task(self._broadcast_loop(), name="gallery_index_progress")
        try:
            # Loading the artist list and the LoRA index sits inside the try on
            # purpose: a malformed user file must end the job with an error, not
            # leave the status stuck on "running" and the progress bar spinning.
            artist_index = load_gallery_artist_index(
                str(settings.get("gallery_artist_list_path") or "")
            )
            known_loras = await self._collect_known_loras()
            loop = asyncio.get_running_loop()
            summary = await loop.run_in_executor(
                None, self._scan_sync, root, recursive, force, artist_index, known_loras
            )
        except Exception as exc:
            logger.error("Gallery scan failed: %s", exc, exc_info=True)
            self._status.update(
                {"running": False, "stage": "error", "progress": 100, "error": str(exc), "last_run": time.time()}
            )
            await self._broadcast()
            return
        finally:
            poller.cancel()
            try:
                await poller
            except (asyncio.CancelledError, Exception):
                pass

        self._status.update(summary)
        self._status.update(
            {"running": False, "stage": "completed", "progress": 100, "last_run": time.time(), "error": None}
        )
        self.cache.set_meta("last_run", str(self._status["last_run"]))
        await self._broadcast()
        logger.info(
            "Gallery scan finished: %s images (%s added, %s updated, %s removed, %s failed)",
            self._status["total"],
            self._status["added"],
            self._status["updated"],
            self._status["removed"],
            self._status["failed"],
        )

    async def _broadcast_loop(self) -> None:
        while True:
            await asyncio.sleep(_PROGRESS_INTERVAL_SECONDS)
            await self._broadcast()

    async def _collect_known_loras(self) -> Dict[str, Optional[str]]:
        """Best-effort name -> sha256 map of the local LoRA library.

        Used for both the "exists locally" badge and the chip that links to the
        LoRA page, so a cold or missing scanner cache degrades to "unknown"
        instead of failing the scan.
        """
        try:
            from ..service_registry import ServiceRegistry

            scanner = await ServiceRegistry.get_lora_scanner()
            cache = await scanner.get_cached_data()
            return build_lora_index(cache)
        except Exception as exc:
            logger.debug("LoRA names unavailable for gallery scan: %s", exc)
            return {}

    def _scan_sync(
        self,
        root: str,
        recursive: bool,
        force: bool,
        artist_index: Any,
        known_loras: Dict[str, Optional[str]],
    ) -> Dict[str, Any]:
        """The blocking half of a scan; runs in the default executor."""
        facts = self.cache.get_indexed_facts()
        added = updated = failed = 0
        processed = 0
        batch: List[Dict[str, Any]] = []

        for image_path in iter_image_paths(root, recursive=recursive):
            processed += 1
            if processed % 25 == 0:
                self._status.update({"total": processed, "indexed": processed})
            try:
                stat = os.stat(image_path)
            except OSError:
                failed += 1
                continue

            if not force and facts.get(image_path) == (stat.st_mtime, stat.st_size):
                continue

            try:
                record = parse_image(
                    image_path,
                    artist_index=artist_index,
                    lora_index=known_loras,
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug("Gallery parse failed for %s: %s", image_path, exc)
                failed += 1
                continue

            if image_path in facts:
                updated += 1
            else:
                added += 1
            batch.append(record)
            if len(batch) >= 50:
                self.cache.upsert_images(batch)
                batch = []
                self._status.update(
                    {
                        "stage": "parsing",
                        "processed": processed,
                        "added": added,
                        "updated": updated,
                        "failed": failed,
                    }
                )

        if batch:
            self.cache.upsert_images(batch)

        # Only rows whose file is provably gone are removed, so turning recursion
        # off or hitting the image cap can never cost the user a rating.
        vanished = [
            path
            for path in facts
            if _is_within_root(path, root) and not os.path.exists(path)
        ]
        removed = self.cache.prune_paths(vanished)

        return {
            "total": processed,
            "indexed": processed,
            "added": added,
            "updated": updated,
            "removed": removed,
            "failed": failed,
        }

    # ---------------------------------------------------------------- queries

    async def list_images(
        self,
        *,
        page: int = 1,
        page_size: int = 40,
        sort: str = "newest",
        rating: str = "all",
        artist: Optional[str] = None,
        lora: Optional[str] = None,
        query: Optional[str] = None,
        metadata: str = "all",
    ) -> Dict[str, Any]:
        items, total = self.cache.list_images(
            page=page,
            page_size=page_size,
            sort=sort,
            rating=rating,
            artist=artist,
            lora=lora,
            query=query,
            metadata=metadata,
        )
        for item in items:
            item["image_url"] = self.image_url(item["image_path"])
        total_pages = (total + page_size - 1) // page_size if page_size else 1
        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        }

    async def set_rating(self, image_path: str, rating: int) -> bool:
        if rating not in VALID_RATINGS:
            raise ValueError(f"Unsupported rating: {rating}")
        return self.cache.set_rating(image_path, rating)

    async def stats(
        self,
        *,
        by: str = "artist",
        sort: str = "net",
        limit: int = 200,
        min_total: int = 1,
    ) -> Dict[str, Any]:
        rows = self.cache.stats_by_lora() if by == "lora" else self.cache.stats_by_artist()
        rows = [row for row in rows if row["total"] >= max(1, min_total)]
        key = _STATS_SORT_KEYS.get(sort, _STATS_SORT_KEYS["net"])
        # Secondary key keeps equal scores in a stable, human-sensible order.
        rows.sort(key=lambda item: (key(item), item["total"], item["key"]), reverse=True)
        for row in rows:
            # The cache hands back paths; a ranking row needs URLs.
            row["images"] = [
                {**image, "image_url": self.image_url(image["image_path"])}
                for image in row.get("images", [])
            ]
        return {
            "by": "lora" if by == "lora" else "artist",
            "totals": self.cache.rating_totals(),
            "items": rows[: max(1, limit)],
        }

    async def list_images_for_lora(
        self,
        *,
        lora_hash: Optional[str] = None,
        lora_name: Optional[str] = None,
        page: int = 1,
        page_size: int = 24,
    ) -> Dict[str, Any]:
        """Images that used one LoRA, for the LoRA modal's gallery tab.

        An unknown hash or name is not an error: the caller gets an empty page,
        which is what an unrated LoRA legitimately looks like.
        """
        items, total = self.cache.list_images_for_lora(
            lora_hash=lora_hash,
            lora_name=lora_name,
            page=page,
            page_size=page_size,
        )
        for item in items:
            item["image_url"] = self.image_url(item["image_path"])
        total_pages = (total + page_size - 1) // page_size if page_size else 1
        return {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
            "summary": self.cache.lora_rating_summary(
                lora_hash=lora_hash, lora_name=lora_name
            ),
            "lora": {"name": lora_name, "hash": lora_hash},
        }

    def get_config(self) -> Dict[str, Any]:
        settings = get_settings_manager()
        root, source = resolve_output_dir(settings)
        artist_list_path = str(settings.get("gallery_artist_list_path") or "")
        # Report the index actually used for normalization: the shipped CSV and
        # the user's list are merged, so the count is the union, not either file.
        index = load_gallery_artist_index(artist_list_path)
        last_run = self.cache.get_meta("last_run")
        return {
            "output_path": root,
            "output_path_source": source,
            "root_exists": bool(root) and os.path.isdir(root),
            "recursive": bool(settings.get("gallery_recursive", True)),
            "artist_list_path": artist_list_path,
            "artist_list_loaded": bool(index),
            "artist_count": len(index),
            "indexed_images": self.cache.count_images(),
            "last_run": float(last_run) if last_run else None,
        }

    # -------------------------------------------------------------- image serve

    @staticmethod
    def image_url(image_path: str) -> str:
        normalized = os.path.normpath(image_path).replace(os.sep, "/")
        return f"/api/lm/gallery/image?path={urllib.parse.quote(normalized, safe='')}"

    def resolve_servable_image(self, image_path: str) -> Optional[str]:
        """Return the absolute path to stream, or ``None`` when not allowed.

        The gallery only ever serves files under the directory it scans, so a
        crafted ``path`` cannot read the rest of the disk.
        """
        if not image_path:
            return None
        candidate = os.path.abspath(image_path)
        root, _source = resolve_output_dir(get_settings_manager())
        if not root or not _is_within_root(candidate, root):
            return None
        if os.path.splitext(candidate)[1].lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"}:
            return None
        return candidate if os.path.isfile(candidate) else None
