"""Route registrar for the gallery endpoints."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Mapping

from aiohttp import web


@dataclass(frozen=True)
class RouteDefinition:
    """Declarative configuration for a HTTP route."""

    method: str
    path: str
    handler_name: str


ROUTE_DEFINITIONS: tuple[RouteDefinition, ...] = (
    RouteDefinition("GET", "/api/lm/gallery/images", "list_gallery_images"),
    RouteDefinition("GET", "/api/lm/gallery/for-lora", "list_gallery_images_for_lora"),
    # GET mirrors POST so the route also works from a plain link or the
    # GET-only companion extension, matching the project-wide convention.
    RouteDefinition("POST", "/api/lm/gallery/rating", "set_gallery_rating"),
    RouteDefinition("GET", "/api/lm/gallery/rating", "set_gallery_rating"),
    RouteDefinition("GET", "/api/lm/gallery/stats", "get_gallery_stats"),
    # Artist thumbnails come from animadex.net; the endpoint proxies the lookup
    # so the browser never talks to a third party directly.
    RouteDefinition("GET", "/api/lm/gallery/artist-preview", "get_gallery_artist_preview"),
    RouteDefinition("POST", "/api/lm/gallery/index", "start_gallery_index"),
    RouteDefinition("GET", "/api/lm/gallery/index", "start_gallery_index"),
    RouteDefinition("GET", "/api/lm/gallery/index/status", "get_gallery_index_status"),
    RouteDefinition("GET", "/api/lm/gallery/image", "serve_gallery_image"),
    RouteDefinition("GET", "/api/lm/gallery/config", "get_gallery_config"),
)


class GalleryRouteRegistrar:
    """Bind declarative gallery routes to an aiohttp router."""

    _METHOD_MAP = {
        "GET": "add_get",
        "POST": "add_post",
        "PUT": "add_put",
        "DELETE": "add_delete",
    }

    def __init__(self, app: web.Application) -> None:
        self._app = app

    def register_routes(
        self,
        handler_lookup: Mapping[str, Callable[[web.Request], object]],
        *,
        definitions: Iterable[RouteDefinition] = ROUTE_DEFINITIONS,
    ) -> None:
        """Register each route definition using the supplied handlers."""

        for definition in definitions:
            handler = handler_lookup[definition.handler_name]
            self._bind_route(definition.method, definition.path, handler)

    def _bind_route(self, method: str, path: str, handler: Callable[[web.Request], object]) -> None:
        add_method_name = self._METHOD_MAP[method.upper()]
        add_method = getattr(self._app.router, add_method_name)
        add_method(path, handler)
