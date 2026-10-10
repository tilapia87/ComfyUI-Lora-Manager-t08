"""Gallery page and API routes.

The page is server-rendered like ``/statistics`` because the shell, header and
navigation are Jinja templates. Unlike the statistics page the gallery owns no
startup state: it reads its cache lazily, so the page renders even before any
scan has run and shows its own empty state instead.
"""

from __future__ import annotations

import functools
import logging
import os

import jinja2
from aiohttp import web

from ..config import config
from ..services.server_i18n import server_i18n
from ..services.settings_manager import get_settings_manager
from ..utils.url_utils import relative_root_prefix
from .gallery_route_registrar import GalleryRouteRegistrar
from .handlers.gallery_handlers import GalleryHandlerSet

logger = logging.getLogger(__name__)


@functools.lru_cache(maxsize=1)
def _app_version() -> str:
    """Return the version used as the ``?v=`` cache-buster for page assets.

    Cached because it is read on every page render and only changes on upgrade.
    Falls back to an empty string, which is what pages render today when no
    version is supplied.
    """
    # __file__ is py/routes/gallery_routes.py, so the project root is 3 levels up.
    root_dir = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    )
    try:
        import toml

        pyproject_path = os.path.join(root_dir, "pyproject.toml")
        if os.path.exists(pyproject_path):
            with open(pyproject_path, "r", encoding="utf-8") as handle:
                data = toml.load(handle)
            return str(data.get("project", {}).get("version", "")).replace("v", "")
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("Could not read the app version: %s", exc)
    return ""


class GalleryRoutes:
    """Route handlers for the gallery page and its API endpoints."""

    def __init__(self) -> None:
        self.handler_set = GalleryHandlerSet()
        self._i18n_filter_added = False
        self.template_env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(config.templates_path),
            autoescape=True,
        )

    async def handle_gallery_page(self, request: web.Request) -> web.Response:
        """Handle GET /gallery."""
        try:
            settings_manager = get_settings_manager()
            server_i18n.set_locale(settings_manager.get("language", "en"))

            if not self._i18n_filter_added:
                self.template_env.filters["t"] = server_i18n.create_template_filter()
                self._i18n_filter_added = True

            template = self.template_env.get_template("gallery.html")
            rendered = template.render(
                is_initializing=False,
                settings=settings_manager,
                request=request,
                t=server_i18n.get_translation,
                rel_prefix=relative_root_prefix(request.path),
                version=_app_version(),
            )
            return web.Response(text=rendered, content_type="text/html")
        except Exception as exc:
            logger.error("Error handling gallery request: %s", exc, exc_info=True)
            return web.Response(text="Error loading gallery page", status=500)

    def setup_routes(self, app: web.Application) -> None:
        """Register the page route and every gallery API route."""
        GalleryRouteRegistrar(app).register_routes(self.handler_set.to_route_mapping())
        app.router.add_get("/gallery", self.handle_gallery_page)
