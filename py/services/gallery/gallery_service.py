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
from .animadex_artists import AnimadexArtistIndex
from .artist_previews import ArtistPreviewService
from .gallery_cache import GalleryCache, VALID_RATINGS
from .gallery_indexer import (
    build_lora_index,
    iter_image_paths,
    parse_image,
    resolve_lora,
    resolve_output_dir,
)
from .lora_previews import build_lora_preview_index

logger = logging.getLogger(__name__)

# The grid draws cards a few hundred pixels wide, so it asks for a downscaled
# thumbnail instead of the full output (see thumbnails.py).
THUMBNAIL_SIZE = 512

# How often the scan reports progress while the blocking walk runs.
_PROGRESS_INTERVAL_SECONDS = 0.5

# The LoRA ranking asks for previews on every page, so the hash -> preview map
# is reused for a short while instead of re-walking the scanner cache.
_LORA_PREVIEW_TTL_SECONDS = 30.0

# How long a ranking request waits for a cold animadex index build before it
# answers with the "loading" state; the UI polls while the build continues in
# the background, so this only controls the first click's latency.
_ANIMADEX_INDEX_WAIT_SECONDS = 1.5

# Rankings can be sorted by the weighted score of the four-level ratings, or by
# the plain vote counts. `net` stays a valid key for older clients; `score` is
# the default because a strong vote carries three times the weight. The four
# exact-level keys rank by how many images sit on one level, so "most loved"
# and "most hated" are answerable without the weighted score blurring them.
_STATS_SORT_KEYS = {
    "score": lambda item: item["score"],
    "net": lambda item: item["net"],
    "likes": lambda item: item["likes"],
    "dislikes": lambda item: item["dislikes"],
    "total": lambda item: item["total"],
    "ratio": lambda item: (item["like_ratio"] if item["like_ratio"] is not None else -1.0),
    "loved": lambda item: item["levels"]["love"],
    "liked": lambda item: item["levels"]["like"],
    "disliked": lambda item: item["levels"]["dislike"],
    "hated": lambda item: item["levels"]["hate"],
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
        self._lora_previews: Dict[str, str] = {}
        self._lora_previews_at: float = 0.0
        self._lora_index_map: Dict[str, Optional[str]] = {}
        self._lora_index_at: float = 0.0

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
        order: str = "desc",
    ) -> Dict[str, Any]:
        ascending = str(order).lower() == "asc"
        items, total = self.cache.list_images(
            page=page,
            page_size=page_size,
            sort=sort,
            rating=rating,
            artist=artist,
            lora=lora,
            query=query,
            metadata=metadata,
            ascending=ascending,
        )
        for item in items:
            item["image_url"] = self.image_url(item["image_path"])
            item["thumb_url"] = self.thumbnail_url(item["image_path"])

        # The scan bakes the LoRA match into the database, so re-resolving it on
        # read is what keeps a newly added or renamed LoRA from showing up as
        # "not in the local library" until a full rescan.
        await self._refresh_lora_matches(items)

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
        sort: str = "score",
        limit: int = 200,
        offset: int = 0,
        min_total: int = 1,
        order: str = "desc",
        animadex_only: bool = False,
    ) -> Dict[str, Any]:
        rows = self.cache.stats_by_lora() if by == "lora" else self.cache.stats_by_artist()

        # The animadex artist catalogue is an optional filter on the artist
        # ranking: the index mirrors the public artist list once and answers
        # membership locally, while the first build reports its progress so the
        # UI can show a loading note instead of an empty table.
        animadex_index: Optional[AnimadexArtistIndex] = None
        animadex_status: Dict[str, Any] = {}
        if by != "lora":
            animadex_index = AnimadexArtistIndex.get_instance()
            if animadex_only:
                await animadex_index.ensure_loaded(wait_seconds=_ANIMADEX_INDEX_WAIT_SECONDS)
            animadex_status = animadex_index.status()
            if animadex_only:
                # Until the first build lands the ranking has nothing valid to
                # show: answer empty and let the UI display the build progress.
                rows = (
                    [row for row in rows if animadex_index.contains(str(row.get("key") or ""))]
                    if animadex_index.ready
                    else []
                )

        rows = [row for row in rows if row["total"] >= max(1, min_total)]
        key = _STATS_SORT_KEYS.get(sort, _STATS_SORT_KEYS["score"])
        # Secondary key keeps equal scores in a stable, human-sensible order.
        rows.sort(key=lambda item: (key(item), item["total"], item["key"]), reverse=True)
        # The ranking is descending by default; reversing before slicing keeps
        # the page numbers consistent with the visible order.
        if str(order).lower() == "asc":
            rows.reverse()

        # The ranking can be thousands of rows long, so the caller pages through
        # it: ``total`` is the number of ranked rows, not of images.
        total = len(rows)
        offset = max(0, offset)
        limit = max(1, limit)
        page_rows = rows[offset : offset + limit]

        for row in page_rows:
            # The cache hands back paths; a ranking row needs URLs. The grid-sized
            # thumbnail is what the cards actually draw.
            row["images"] = [
                {
                    **image,
                    "image_url": self.image_url(image["image_path"]),
                    "thumb_url": self.thumbnail_url(image["image_path"]),
                }
                for image in row.get("images", [])
            ]

        if by == "lora":
            # The ranking row is the same model the LoRA page shows, so reuse
            # that page's preview instead of making the client look it up. The
            # name is re-resolved first: the database hash can be stale when the
            # LoRA was installed (or renamed) after the last scan.
            index = await self._lora_index()
            previews = await self._lora_preview_map()
            for row in page_rows:
                installed, digest = resolve_lora(str(row.get("key") or ""), index)
                if installed:
                    row["known"] = True
                    if digest:
                        row["hash"] = digest
                row["preview_url"] = previews.get(str(row.get("hash") or ""), "")

        return {
            "by": "lora" if by == "lora" else "artist",
            "totals": self.cache.rating_totals(),
            "total": total,
            "offset": offset,
            "limit": limit,
            "items": page_rows,
            # Present for the artist ranking only; the UI uses it to show the
            # animadex filter state and to poll while the first build runs.
            "animadex": animadex_status,
        }

    async def summary(self) -> Dict[str, Any]:
        """Whole-gallery counts behind the summary bar and the facet chips.

        Kept beside :meth:`stats` because the two share the same snapshot; the
        cache derives every number in one query, so the headline score and the
        per-level counts can never disagree with each other.
        """
        return self.cache.rating_totals()

    async def _lora_index(self) -> Dict[str, Optional[str]]:
        """``name -> sha256`` of the current local LoRA library.

        Shared by the read-time chip refresh and the ranking, and reused for a
        short while because both run on every page request.
        """
        now = time.monotonic()
        if self._lora_index_map and now - self._lora_index_at < _LORA_PREVIEW_TTL_SECONDS:
            return self._lora_index_map
        try:
            from ..service_registry import ServiceRegistry

            scanner = await ServiceRegistry.get_lora_scanner()
            cache = await scanner.get_cached_data()
            self._lora_index_map = build_lora_index(cache)
            self._lora_index_at = now
        except Exception as exc:
            logger.debug("LoRA library unavailable for gallery: %s", exc)
        return self._lora_index_map

    async def _refresh_lora_matches(self, items: Sequence[Dict[str, Any]]) -> None:
        """Re-resolve each image's LoRA chips against the current library.

        Only upgrades a chip: an entry the scan already resolved keeps its hash,
        and a miss never turns a previously resolved chip back into "missing".
        """
        index = await self._lora_index()
        if not index:
            return
        for item in items:
            for lora in item.get("loras") or []:
                if lora.get("hash"):
                    continue
                installed, digest = resolve_lora(str(lora.get("name") or ""), index)
                if installed:
                    lora["exists_locally"] = True
                    if digest:
                        lora["hash"] = digest

    async def _lora_preview_map(self) -> Dict[str, str]:
        """``sha256`` -> preview URL of the local LoRA library.

        Reused for a short while because every statistics page asks for it; a
        cold scanner cache degrades to "no previews", never to an error.
        """
        now = time.monotonic()
        if self._lora_previews and now - self._lora_previews_at < _LORA_PREVIEW_TTL_SECONDS:
            return self._lora_previews
        try:
            from ..service_registry import ServiceRegistry

            scanner = await ServiceRegistry.get_lora_scanner()
            cache = await scanner.get_cached_data()
            self._lora_previews = build_lora_preview_index(cache)
            self._lora_previews_at = now
        except Exception as exc:
            logger.debug("LoRA previews unavailable for gallery stats: %s", exc)
        return self._lora_previews

    async def artist_preview(self, artist: str) -> Dict[str, Any]:
        """Best-effort artist thumbnail from animadex.net."""
        return await ArtistPreviewService.get_instance().get(artist)

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
            item["thumb_url"] = self.thumbnail_url(item["image_path"])
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

    @staticmethod
    def thumbnail_url(image_path: str, size: Optional[int] = None) -> str:
        """Grid-sized preview URL for one image.

        The side comes from the `gallery_thumbnail_size` setting so the whole
        grid can be resized from the gallery settings panel.
        """
        if not size:
            try:
                size = int(get_settings_manager().get("gallery_thumbnail_size") or THUMBNAIL_SIZE)
            except (TypeError, ValueError):
                size = THUMBNAIL_SIZE
        normalized = os.path.normpath(image_path).replace(os.sep, "/")
        return (
            "/api/lm/gallery/thumbnail"
            f"?path={urllib.parse.quote(normalized, safe='')}&size={int(size)}"
        )

    def thumbnail_cache_info(self) -> Dict[str, Any]:
        """What the on-disk thumbnail cache currently holds."""
        from .thumbnails import cache_stats

        info = cache_stats()
        try:
            info["size"] = int(get_settings_manager().get("gallery_thumbnail_size") or THUMBNAIL_SIZE)
        except (TypeError, ValueError):
            info["size"] = THUMBNAIL_SIZE
        return info

    def clear_thumbnail_cache(self) -> Dict[str, Any]:
        """Drop every cached thumbnail (the next request regenerates them)."""
        from .thumbnails import clear_cache

        return clear_cache()

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
