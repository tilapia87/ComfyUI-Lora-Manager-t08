"""HTTP handlers for the gallery endpoints.

Handlers stay thin: parse and validate the request, delegate to
:class:`~py.services.gallery.gallery_service.GalleryService`, and translate
errors into the project's ``{"success": false, "error": ...}`` contract.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional

from aiohttp import web

from ...services.gallery.gallery_service import GalleryService
from ...services.gallery.thumbnails import (
    DEFAULT_THUMBNAIL_SIZE,
    MAX_THUMBNAIL_SIZE,
    MIN_THUMBNAIL_SIZE,
    thumbnail_for,
)

logger = logging.getLogger(__name__)

_CACHE_CONTROL = "public, max-age=86400"


def _parse_int(value: Any, default: int, *, minimum: int = 1, maximum: int = 1_000_000) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def _error(message: str, status: int = 500) -> web.Response:
    return web.json_response({"success": False, "error": message}, status=status)


@dataclass(frozen=True)
class GalleryHandlerSet:
    """The gallery's route handlers, keyed by the registrar's handler names."""

    def to_route_mapping(self) -> Mapping[str, Callable[[web.Request], Awaitable[web.StreamResponse]]]:
        return {
            "list_gallery_images": self.list_images,
            "list_gallery_images_for_lora": self.list_images_for_lora,
            "set_gallery_rating": self.set_rating,
            "get_gallery_stats": self.get_stats,
            "get_gallery_summary": self.get_summary,
            "get_gallery_artist_preview": self.get_artist_preview,
            "start_gallery_index": self.start_index,
            "get_gallery_index_status": self.get_index_status,
            "serve_gallery_image": self.serve_image,
            "serve_gallery_thumbnail": self.serve_thumbnail,
            "get_gallery_thumbnail_cache": self.get_thumbnail_cache,
            "clear_gallery_thumbnail_cache": self.clear_thumbnail_cache,
            "get_gallery_config": self.get_config,
        }

    @staticmethod
    async def _service() -> GalleryService:
        return await GalleryService.get_instance()

    async def list_images(self, request: web.Request) -> web.Response:
        try:
            query = request.query
            page = _parse_int(query.get("page"), 1, minimum=1)
            page_size = _parse_int(query.get("page_size"), 40, minimum=1, maximum=200)
            # An unknown value falls back to "all" rather than erroring, so an
            # older frontend keeps working against a newer backend.
            metadata = (query.get("metadata") or "all").lower()
            if metadata not in ("all", "with", "without"):
                metadata = "all"
            order = "asc" if (query.get("order") or "").lower() == "asc" else "desc"
            service = await self._service()
            data = await service.list_images(
                page=page,
                page_size=page_size,
                sort=query.get("sort") or "newest",
                rating=query.get("rating") or "all",
                artist=query.get("artist") or None,
                lora=query.get("lora") or None,
                query=(query.get("q") or "").strip() or None,
                metadata=metadata,
                order=order,
            )
            return web.json_response({"success": True, "data": data})
        except Exception as exc:
            logger.error("Gallery list failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def list_images_for_lora(self, request: web.Request) -> web.Response:
        """Images that used one LoRA, for the LoRA modal's gallery tab."""
        try:
            query = request.query
            lora_hash = (query.get("hash") or "").strip() or None
            lora_name = (query.get("name") or "").strip() or None
            if not lora_hash and not lora_name:
                # Asking for nothing would otherwise look like "every image".
                return _error("hash or name is required", 400)
            service = await self._service()
            data = await service.list_images_for_lora(
                lora_hash=lora_hash,
                lora_name=lora_name,
                page=_parse_int(query.get("page"), 1, minimum=1),
                page_size=_parse_int(query.get("page_size"), 24, minimum=1, maximum=200),
            )
            return web.json_response({"success": True, "data": data})
        except Exception as exc:
            logger.error("Gallery for-lora failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def set_rating(self, request: web.Request) -> web.Response:
        try:
            payload: Dict[str, Any] = dict(request.query)
            if request.method == "POST":
                try:
                    body = await request.json()
                    if isinstance(body, dict):
                        payload.update(body)
                except Exception:
                    # Fall back to the query string so the GET form keeps working.
                    pass

            image_path = str(payload.get("image_path") or "").strip()
            if not image_path:
                return _error("image_path is required", 400)
            try:
                rating = int(payload.get("rating"))
            except (TypeError, ValueError):
                return _error("rating must be -3, -1, 0, 1 or 3", 400)

            service = await self._service()
            updated = await service.set_rating(image_path, rating)
            if not updated:
                return _error("Image is not in the gallery index", 404)
            return web.json_response(
                {"success": True, "data": {"image_path": image_path, "rating": rating}}
            )
        except ValueError as exc:
            return _error(str(exc), 400)
        except Exception as exc:
            logger.error("Gallery rating failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def get_stats(self, request: web.Request) -> web.Response:
        try:
            query = request.query
            by = "lora" if (query.get("by") or "").lower() == "lora" else "artist"
            service = await self._service()
            data = await service.stats(
                by=by,
                sort=query.get("sort") or "score",
                limit=_parse_int(query.get("limit"), 200, minimum=1, maximum=1000),
                offset=_parse_int(query.get("offset"), 0, minimum=0, maximum=10_000_000),
                min_total=_parse_int(query.get("min_total"), 1, minimum=1, maximum=1000),
                order="asc" if (query.get("order") or "").lower() == "asc" else "desc",
                animadex_only=(query.get("animadex_only") or "").lower() in ("1", "true", "yes", "on"),
            )
            return web.json_response({"success": True, "data": data})
        except Exception as exc:
            logger.error("Gallery stats failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def get_summary(self, request: web.Request) -> web.Response:
        """Headline counts for the gallery summary bar and its facet chips."""
        try:
            service = await self._service()
            return web.json_response({"success": True, "data": await service.summary()})
        except Exception as exc:
            logger.error("Gallery summary failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def get_artist_preview(self, request: web.Request) -> web.Response:
        """Sample thumbnail for one artist of the ranking (animadex.net)."""
        try:
            name = (request.query.get("name") or "").strip()
            if not name:
                return _error("name is required", 400)
            service = await self._service()
            data = await service.artist_preview(name)
            return web.json_response({"success": True, "data": data})
        except Exception as exc:
            logger.error("Gallery artist preview failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def start_index(self, request: web.Request) -> web.Response:
        try:
            raw_force: Any = request.query.get("force")
            if request.method == "POST":
                try:
                    body = await request.json()
                    if isinstance(body, dict) and "force" in body:
                        raw_force = body.get("force")
                except Exception:
                    pass
            force = str(raw_force).lower() in {"1", "true", "yes"} if raw_force is not None else False

            service = await self._service()
            result = await service.start_index(force=force)
            return web.json_response({"success": True, "data": result})
        except Exception as exc:
            logger.error("Gallery index start failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def get_index_status(self, request: web.Request) -> web.Response:
        try:
            service = await self._service()
            return web.json_response({"success": True, "data": service.get_status()})
        except Exception as exc:
            logger.error("Gallery index status failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def serve_image(self, request: web.Request) -> web.StreamResponse:
        raw_path = request.query.get("path") or ""
        service = await self._service()
        resolved = service.resolve_servable_image(raw_path)
        if not resolved:
            raise web.HTTPForbidden(text="Gallery image is not within the scanned output directory")
        return web.FileResponse(
            path=resolved,
            chunk_size=1024 * 1024,
            headers={"Cache-Control": _CACHE_CONTROL},
        )

    async def serve_thumbnail(self, request: web.Request) -> web.StreamResponse:
        """Grid-sized preview of one gallery image.

        Falls back to the original bytes when a thumbnail cannot be produced, so
        a missing Pillow or an exotic format never breaks the grid.
        """
        raw_path = request.query.get("path") or ""
        size = _parse_int(
            request.query.get("size"),
            DEFAULT_THUMBNAIL_SIZE,
            minimum=MIN_THUMBNAIL_SIZE,
            maximum=MAX_THUMBNAIL_SIZE,
        )
        service = await self._service()
        resolved = service.resolve_servable_image(raw_path)
        if not resolved:
            raise web.HTTPForbidden(text="Gallery image is not within the scanned output directory")
        thumbnail_path = await asyncio.to_thread(thumbnail_for, resolved, size)
        if not thumbnail_path:
            return web.FileResponse(
                path=resolved,
                chunk_size=1024 * 1024,
                headers={"Cache-Control": _CACHE_CONTROL},
            )
        return web.FileResponse(
            path=thumbnail_path,
            chunk_size=256 * 1024,
            headers={"Cache-Control": _CACHE_CONTROL, "Content-Type": "image/webp"},
        )

    async def get_thumbnail_cache(self, request: web.Request) -> web.Response:
        """How many thumbnails are cached and how much space they take."""
        try:
            service = await self._service()
            return web.json_response({"success": True, "data": service.thumbnail_cache_info()})
        except Exception as exc:
            logger.error("Gallery thumbnail cache info failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def clear_thumbnail_cache(self, request: web.Request) -> web.Response:
        """Delete the cached thumbnails; they are regenerated on demand."""
        try:
            service = await self._service()
            return web.json_response({"success": True, "data": service.clear_thumbnail_cache()})
        except Exception as exc:
            logger.error("Gallery thumbnail cache clear failed: %s", exc, exc_info=True)
            return _error(str(exc))

    async def get_config(self, request: web.Request) -> web.Response:
        try:
            service = await self._service()
            return web.json_response({"success": True, "data": service.get_config()})
        except Exception as exc:
            logger.error("Gallery config failed: %s", exc, exc_info=True)
            return _error(str(exc))
