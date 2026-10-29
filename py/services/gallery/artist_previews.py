"""Artist preview thumbnails, resolved through animadex.net.

The gallery's artist ranking is about people, so the statistics table can show
a sample artwork per artist. animadex.net indexes danbooru artists and serves a
thumbnail per artist, so this module queries its public search API and keeps a
small TTL cache in front of it.

The lookup is strictly best-effort: a missing network, a slow or failing
upstream, or an unexpected payload shape all resolve to an empty thumbnail, and
the statistics table keeps its gallery image instead.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional

import aiohttp

logger = logging.getLogger(__name__)

ANIMADEX_API_BASE = "https://animadex.net"
ANIMADEX_ARTIST_SEARCH_PATH = "/api/artists/search"
_SEARCH_TIMEOUT = aiohttp.ClientTimeout(total=8, connect=4)
_CACHE_TTL_SECONDS = 6 * 60 * 60
_MAX_CACHE_ENTRIES = 4096
# The table asks for a whole page of artists at once; keep the upstream load
# bounded without making a page wait on a long serial chain.
_MAX_CONCURRENCY = 4


def _empty(artist: str) -> Dict[str, Any]:
    return {
        "artist": artist,
        "matched_name": "",
        "thumb_url": "",
        "page_url": "",
        "count": 0,
    }


class ArtistPreviewService:
    """Resolve one artist name to an animadex thumbnail, with a TTL cache."""

    _instance: Optional["ArtistPreviewService"] = None

    def __init__(self) -> None:
        self._cache: Dict[str, tuple[float, Dict[str, Any]]] = {}
        self._semaphore = asyncio.Semaphore(_MAX_CONCURRENCY)

    @classmethod
    def get_instance(cls) -> "ArtistPreviewService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Drop the process-wide instance. Used by tests."""
        cls._instance = None

    async def get(self, artist: str) -> Dict[str, Any]:
        name = (artist or "").strip()
        if not name:
            return _empty(artist or "")
        cached = self._cache.get(name.lower())
        if cached and time.monotonic() - cached[0] < _CACHE_TTL_SECONDS:
            return dict(cached[1])

        async with self._semaphore:
            # Re-check inside the semaphore: a page renders many rows at once
            # and two of them may ask for the same artist.
            cached = self._cache.get(name.lower())
            if cached and time.monotonic() - cached[0] < _CACHE_TTL_SECONDS:
                return dict(cached[1])
            result = await self._lookup(name)
            self._cache[name.lower()] = (time.monotonic(), result)
            self._trim_cache()
            return dict(result)

    def _trim_cache(self) -> None:
        if len(self._cache) <= _MAX_CACHE_ENTRIES:
            return
        oldest = sorted(self._cache.items(), key=lambda item: item[1][0])
        for key, _entry in oldest[: len(self._cache) - _MAX_CACHE_ENTRIES]:
            self._cache.pop(key, None)

    async def _lookup(self, artist: str) -> Dict[str, Any]:
        url = ANIMADEX_API_BASE + ANIMADEX_ARTIST_SEARCH_PATH
        try:
            async with aiohttp.ClientSession(timeout=_SEARCH_TIMEOUT) as session:
                async with session.get(
                    url,
                    params={"q": artist, "page": 1},
                    headers={"Accept": "application/json"},
                ) as response:
                    if response.status != 200:
                        logger.debug(
                            "animadex artist lookup for %r returned HTTP %s",
                            artist,
                            response.status,
                        )
                        return _empty(artist)
                    payload = await response.json(content_type=None)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("animadex artist lookup for %r failed: %s", artist, exc)
            return _empty(artist)

        results = payload.get("results") if isinstance(payload, dict) else None
        if not isinstance(results, list):
            return _empty(artist)

        with_thumb = [
            item
            for item in results
            if isinstance(item, dict) and isinstance(item.get("thumb_url"), str) and item["thumb_url"]
        ]
        if not with_thumb:
            return _empty(artist)

        lowered = artist.lower()
        best = next(
            (
                item
                for item in with_thumb
                if str(item.get("trigger") or "").lower() == lowered
                or str(item.get("name") or "").lower() == lowered
            ),
            with_thumb[0],
        )
        try:
            count = int(best.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        return {
            "artist": artist,
            "matched_name": str(best.get("name") or ""),
            "thumb_url": str(best.get("thumb_url") or ""),
            "page_url": str(best.get("url") or ""),
            "count": count,
        }
