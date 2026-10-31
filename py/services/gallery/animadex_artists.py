"""Membership index for artists the animadex.net catalogue knows about.

The gallery's artist ranking can be limited to artists the ANIMA model's
animadex catalogue lists (those are the artists whose tags the model was trained
on). animadex exposes a public, paginated artist search API, so this module
mirrors the whole artist list once into a small JSON cache next to the gallery
database and then answers membership checks without a network round-trip per
ranking row.

The build is strictly best-effort and never blocks the event loop: the first
caller starts a background task, the stats endpoint reports the build progress,
and a failed refresh falls back to the previous cache (if any) so the filter
keeps working offline.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional, Set, Tuple

import aiohttp

from ...utils.artist_tags import fold_artist_name
from ...utils.cache_paths import get_cache_base_dir

logger = logging.getLogger(__name__)

ANIMADEX_API_BASE = "https://animadex.net"
ANIMADEX_ARTIST_SEARCH_PATH = "/api/artists/search"

# The public search API always pages at 36 items; ``page_size`` is ignored.
_UPSTREAM_PAGE_SIZE = 36
# Polite concurrency: the catalogue has ~450 pages today, so a modest pool
# keeps the first build under a minute without hammering the upstream.
_MAX_CONCURRENCY = 8
_SEARCH_TIMEOUT = aiohttp.ClientTimeout(total=20, connect=5)
# A week is plenty for an artist catalogue; the cache keeps a stale copy around
# as a fallback when the refresh fails.
_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
_RETRY_DELAY_SECONDS = 60.0
# Safety cap so a broken ``pages`` value cannot turn into an endless loop.
_MAX_PAGES = 3000
_CACHE_FILE_NAME = "animadex_artists.json"


def _default_cache_path() -> str:
    directory = os.path.join(get_cache_base_dir(create=True), "gallery")
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, _CACHE_FILE_NAME)


def _short_error(exc: BaseException) -> str:
    text = str(exc) or exc.__class__.__name__
    return text[:200]


class AnimadexArtistIndex:
    """Lazily built, cached set of folded animadex artist names."""

    _instance: Optional["AnimadexArtistIndex"] = None

    def __init__(self, cache_path: Optional[str] = None) -> None:
        self._cache_path = cache_path or _default_cache_path()
        self._names: Set[str] = set()
        self._ready = False
        self._loading = False
        self._error = ""
        self._fetched_at = 0.0
        self._pages_done = 0
        self._pages_total = 0
        self._task: Optional[asyncio.Task] = None
        self._retry_after = 0.0

    @classmethod
    def get_instance(cls) -> "AnimadexArtistIndex":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Drop the process-wide instance. Used by tests."""
        cls._instance = None

    # -- queries ---------------------------------------------------------

    @property
    def ready(self) -> bool:
        return self._ready

    def status(self) -> Dict[str, Any]:
        """Small JSON-able summary for the ranking payload and the UI."""
        return {
            "ready": self._ready,
            "loading": self._loading,
            "count": len(self._names),
            "fetched_at": self._fetched_at,
            "progress": {"done": self._pages_done, "total": self._pages_total},
            "error": self._error,
        }

    def contains(self, artist: str) -> bool:
        """Whether *artist* exists in the animadex catalogue (folded compare)."""
        folded = fold_artist_name(artist)
        return bool(folded) and folded in self._names

    # -- build / cache ---------------------------------------------------

    def _is_fresh(self) -> bool:
        return bool(self._fetched_at) and (time.time() - self._fetched_at) < _CACHE_TTL_SECONDS

    async def ensure_loaded(self, *, wait_seconds: float = 0.0) -> bool:
        """Make sure an index is available or being built; True when usable.

        The first caller starts the build in the background, later callers just
        join it, so a page of ranking rows never queues a second download. A
        short ``wait_seconds`` lets a request return a warm cache immediately
        instead of flashing the unfiltered list on the first click.
        """
        if self._ready and self._is_fresh():
            return True
        if not self._loading and time.monotonic() >= self._retry_after:
            self._loading = True
            self._error = ""
            self._pages_done = 0
            self._pages_total = 0
            self._task = asyncio.ensure_future(self._build())
        task = self._task
        if wait_seconds > 0 and task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=wait_seconds)
            except asyncio.TimeoutError:
                pass
        return self._ready

    async def _build(self) -> None:
        try:
            cached = self._read_cache()
            if cached is not None:
                names, fetched_at = cached
                self._names = names
                self._fetched_at = fetched_at
                # A stale snapshot stays usable while a refresh is in flight.
                self._ready = True
                if self._is_fresh():
                    return
            names, pages = await self._fetch_all()
            self._names = names
            self._fetched_at = time.time()
            self._ready = True
            self._error = ""
            self._pages_total = pages or self._pages_total
            self._write_cache()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - best effort upstream
            logger.debug("animadex artist index build failed: %s", exc)
            self._error = _short_error(exc)
            self._retry_after = time.monotonic() + _RETRY_DELAY_SECONDS
        finally:
            self._loading = False

    def _read_cache(self) -> Optional[Tuple[Set[str], float]]:
        try:
            with open(self._cache_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            return None
        if not isinstance(payload, dict):
            return None
        raw_names = payload.get("names")
        if not isinstance(raw_names, list):
            return None
        try:
            fetched_at = float(payload.get("fetched_at") or 0)
        except (TypeError, ValueError):
            fetched_at = 0.0
        names = {str(name) for name in raw_names if isinstance(name, str) and name}
        if not names:
            return None
        return names, fetched_at

    def _write_cache(self) -> None:
        payload = {
            "fetched_at": self._fetched_at,
            "count": len(self._names),
            "names": sorted(self._names),
        }
        try:
            os.makedirs(os.path.dirname(self._cache_path), exist_ok=True)
            temporary = self._cache_path + ".part"
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
            os.replace(temporary, self._cache_path)
        except OSError as exc:
            # A read-only cache directory must not disable the filter.
            logger.debug("could not persist the animadex artist index: %s", exc)

    # -- upstream --------------------------------------------------------

    async def _fetch_all(self) -> Tuple[Set[str], int]:
        async with aiohttp.ClientSession(timeout=_SEARCH_TIMEOUT) as session:
            first = await self._fetch_page(session, 1)
            if first is None:
                raise RuntimeError("animadex artist search is unavailable")
            names, pages = first
            pages = max(1, min(pages, _MAX_PAGES))
            self._pages_total = pages
            self._pages_done = 1
            if pages <= 1:
                return names, pages

            semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)

            async def worker(page: int) -> None:
                async with semaphore:
                    result = await self._fetch_page(session, page)
                if result is not None:
                    names.update(result[0])
                self._pages_done += 1

            await asyncio.gather(*(worker(page) for page in range(2, pages + 1)))
            return names, pages

    async def _fetch_page(
        self, session: "aiohttp.ClientSession", page: int
    ) -> Optional[Tuple[Set[str], int]]:
        url = ANIMADEX_API_BASE + ANIMADEX_ARTIST_SEARCH_PATH
        try:
            async with session.get(
                url,
                params={"q": "", "page": page},
                headers={"Accept": "application/json"},
            ) as response:
                if response.status != 200:
                    logger.debug(
                        "animadex artist search page %s returned HTTP %s",
                        page,
                        response.status,
                    )
                    return None
                payload = await response.json(content_type=None)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - best effort upstream
            logger.debug("animadex artist search page %s failed: %s", page, exc)
            return None

        if not isinstance(payload, dict):
            return None
        results = payload.get("results")
        if not isinstance(results, list):
            return None
        try:
            pages = int(payload.get("pages") or 1)
        except (TypeError, ValueError):
            pages = 1
        names: Set[str] = set()
        for item in results:
            if not isinstance(item, dict):
                continue
            for field in ("name", "trigger", "slug"):
                folded = fold_artist_name(str(item.get(field) or ""))
                if folded:
                    names.add(folded)
        return names, pages
