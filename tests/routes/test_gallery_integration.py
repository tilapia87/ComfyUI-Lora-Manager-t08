"""Cross-layer integration test: the real aiohttp app renders /gallery and serves the API.

This is the test that proves the template, the page route, the API routes and the
service agree with each other -- the unit tests can all pass while the page route
500s because the template is missing.
"""

from __future__ import annotations

import os

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from py.routes.gallery_routes import GalleryRoutes
from py.services.settings_manager import get_settings_manager


@pytest.fixture
async def client():
    app = web.Application()
    GalleryRoutes().setup_routes(app)
    test_client = TestClient(TestServer(app))
    await test_client.start_server()
    try:
        yield test_client
    finally:
        await test_client.close()


async def test_gallery_page_renders_the_template(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path))

    response = await client.get("/gallery")
    assert response.status == 200
    assert response.content_type == "text/html"

    html = await response.text()
    # The shell must identify the page and load the page module.
    assert 'data-page="gallery"' in html
    assert "loras_static/js/gallery.js" in html
    # The stylesheet is pulled in globally by style.css rather than per page.
    assert "loras_static/css/style.css" in html


async def test_gallery_page_is_linked_from_the_header(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path))
    html = await (await client.get("/gallery")).text()
    assert "galleryNavItem" in html


async def test_config_endpoint_reports_the_configured_output_directory(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path))
    response = await client.get("/api/lm/gallery/config")
    assert response.status == 200
    body = await response.json()
    assert body["success"] is True
    assert body["data"]["output_path_source"] == "setting"
    assert body["data"]["root_exists"] is True


async def test_images_endpoint_is_empty_before_any_scan(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path))
    response = await client.get("/api/lm/gallery/images?page=1&page_size=10")
    assert response.status == 200
    body = await response.json()
    assert body["success"] is True
    assert body["data"]["total"] == 0
    assert body["data"]["items"] == []


@pytest.mark.parametrize("value", ["all", "with", "without", "bogus", ""])
async def test_images_endpoint_accepts_every_metadata_value(client, tmp_path, value):
    """The metadata filter must never turn a bad or absent value into a 4xx/5xx."""
    get_settings_manager().set("gallery_output_path", str(tmp_path))
    response = await client.get("/api/lm/gallery/images", params={"metadata": value})
    assert response.status == 200
    body = await response.json()
    assert body["success"] is True
    assert body["data"]["total"] == 0


async def test_index_status_endpoint_reports_idle_state(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path))
    body = await (await client.get("/api/lm/gallery/index/status")).json()
    assert body["data"]["running"] is False
    assert body["data"]["stage"] in {"idle", "completed"}


async def test_image_endpoint_refuses_paths_outside_the_output_directory(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path / "output"))

    response = await client.get("/api/lm/gallery/image", params={"path": r"C:\Windows\win.ini"})
    assert response.status == 403

    response = await client.get("/api/lm/gallery/image", params={"path": str(tmp_path / "secret.png")})
    assert response.status == 403


async def test_rating_endpoint_validates_its_payload(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path))

    response = await client.post("/api/lm/gallery/rating", json={"image_path": "/x.png", "rating": 1})
    assert response.status == 404

    response = await client.post("/api/lm/gallery/rating", json={"rating": 1})
    assert response.status == 400
    assert (await response.json())["success"] is False


async def test_stats_endpoint_is_usable_before_any_rating(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path))
    body = await (await client.get("/api/lm/gallery/stats?by=artist")).json()
    assert body["success"] is True
    assert body["data"]["items"] == []
    assert body["data"]["totals"]["images"] == 0


def test_gallery_stylesheet_is_imported_globally():
    """The page ships no <link>; forgetting the import leaves it unstyled."""
    from py.config import config

    style_css = os.path.join(config.static_path, "css", "style.css")
    with open(style_css, "r", encoding="utf-8") as handle:
        content = handle.read()
    assert "components/gallery.css" in content


async def test_page_assets_carry_a_version_cache_buster(client, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path))
    html = await (await client.get("/gallery")).text()
    from py.routes.gallery_routes import _app_version

    version = _app_version()
    assert version, "pyproject.toml should supply a version"
    assert f"loras_static/js/gallery.js?v={version}" in html
    assert f"loras_static/css/style.css?v={version}" in html
