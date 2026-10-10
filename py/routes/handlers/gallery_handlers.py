"""HTTP handlers for the gallery endpoints.

Handlers stay thin: parse and validate the request, delegate to
:class:`~py.services.gallery.gallery_service.GalleryService`, and translate
errors into the project's ``{"success": false, "error": ...}`` contract.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Mapping, Optional

from aiohttp import web

from ...services.gallery.gallery_service import GalleryService

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
            "set_gallery_rating": self.set_rating,
            "get_gallery_stats": self.get_stats,
            "start_gallery_index": self.start_index,
            "get_gallery_index_status": self.get_index_status,
            "serve_gallery_image": self.serve_image,
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
            )
            return web.json_response({"success": True, "data": data})
        except Exception as exc:
            logger.error("Gallery list failed: %s", exc, exc_info=True)
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
                return _error("rating must be -1, 0 or 1", 400)

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
                sort=query.get("sort") or "net",
                limit=_parse_int(query.get("limit"), 200, minimum=1, maximum=1000),
                min_total=_parse_int(query.get("min_total"), 1, minimum=1, maximum=1000),
            )
            return web.json_response({"success": True, "data": data})
        except Exception as exc:
            logger.error("Gallery stats failed: %s", exc, exc_info=True)
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

    async def get_config(self, request: web.Request) -> web.Response:
        try:
            service = await self._service()
            return web.json_response({"success": True, "data": service.get_config()})
        except Exception as exc:
            logger.error("Gallery config failed: %s", exc, exc_info=True)
            return _error(str(exc))
