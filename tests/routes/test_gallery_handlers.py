"""Tests for the gallery HTTP handlers and route registration."""

from __future__ import annotations

import json

import pytest
from aiohttp import web

from py.routes.gallery_route_registrar import (
    GalleryRouteRegistrar,
    ROUTE_DEFINITIONS,
)
from py.routes.handlers.gallery_handlers import GalleryHandlerSet
from py.services.gallery.gallery_cache import GalleryCache
from py.services.gallery.gallery_service import GalleryService
from py.services.settings_manager import get_settings_manager


class FakeRequest:
    """Minimal stand-in for ``web.Request`` covering query, json and method."""

    def __init__(self, *, query=None, body=None, method="GET"):
        self.query = query or {}
        self.method = method
        self._body = body

    async def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


def _payload(response) -> dict:
    return json.loads(response.text)


@pytest.fixture
def service(tmp_path, monkeypatch):
    """A gallery service whose cache is pre-loaded with one rated image."""
    cache = GalleryCache(str(tmp_path / "gallery.sqlite"))
    cache.upsert_images(
        [
            {
                "image_path": str(tmp_path / "output" / "a.png"),
                "file_name": "a.png",
                "mtime": 1.0,
                "size": 10,
                "width": 8,
                "height": 8,
                "prompt": "1girl, @nnn yryr",
                "negative_prompt": "worst quality",
                "parser": "comfy",
                "gen_params": {},
                "has_metadata": True,
                "artists": [{"name": "nnn yryr", "canonical": "nnn yryr", "known": True}],
                "loras": [{"name": "style_a.safetensors", "weight": 0.8, "exists_locally": False}],
            }
        ]
    )
    instance = GalleryService(cache=cache)
    monkeypatch.setattr(GalleryService, "_instance", instance)
    yield instance


def test_every_route_definition_has_a_handler(service):
    mapping = GalleryHandlerSet().to_route_mapping()
    for definition in ROUTE_DEFINITIONS:
        assert definition.handler_name in mapping, definition
        assert definition.path.startswith("/api/lm/gallery/")


def test_registrar_binds_every_definition():
    registered = []

    class Router:
        def __getattr__(self, name):
            def _add(path, handler):
                registered.append((name, path, handler))

            return _add

    class App:
        router = Router()

    GalleryRouteRegistrar(App()).register_routes(GalleryHandlerSet().to_route_mapping())
    assert len(registered) == len(ROUTE_DEFINITIONS)


async def test_list_images_returns_the_contract_shape(service):
    response = await GalleryHandlerSet().list_images(
        FakeRequest(query={"page": "1", "page_size": "10"})
    )
    assert response.status == 200
    body = _payload(response)
    assert body["success"] is True
    data = body["data"]
    assert set(data) == {"items", "total", "page", "page_size", "total_pages"}
    item = data["items"][0]
    assert item["file_name"] == "a.png"
    assert item["artists"][0]["canonical"] == "nnn yryr"
    assert item["image_url"].startswith("/api/lm/gallery/image?path=")


async def test_list_images_clamps_page_size(service):
    response = await GalleryHandlerSet().list_images(FakeRequest(query={"page_size": "9999"}))
    assert _payload(response)["data"]["page_size"] == 200


@pytest.fixture
def mixed_metadata_service(tmp_path, monkeypatch):
    """Two images, one with readable metadata and one without."""
    cache = GalleryCache(str(tmp_path / "gallery.sqlite"))

    def _record(name, has_metadata):
        return {
            "image_path": str(tmp_path / "output" / name),
            "file_name": name,
            "mtime": 1.0,
            "size": 10,
            "width": 8,
            "height": 8,
            "prompt": "1girl, @nnn yryr" if has_metadata else None,
            "negative_prompt": None,
            "parser": "comfy" if has_metadata else None,
            "gen_params": {},
            "has_metadata": has_metadata,
            "artists": [],
            "loras": [],
        }

    cache.upsert_images([_record("with.png", True), _record("without.png", False)])
    instance = GalleryService(cache=cache)
    monkeypatch.setattr(GalleryService, "_instance", instance)
    return instance


async def test_metadata_query_parameter_filters_the_listing(mixed_metadata_service):
    handler = GalleryHandlerSet()

    async def names(**query):
        body = _payload(await handler.list_images(FakeRequest(query=query)))
        return sorted(item["file_name"] for item in body["data"]["items"])

    assert await names() == ["with.png", "without.png"]
    assert await names(metadata="all") == ["with.png", "without.png"]
    assert await names(metadata="with") == ["with.png"]
    assert await names(metadata="without") == ["without.png"]
    # An unknown value degrades to "all" instead of erroring, so a stale
    # frontend cannot break against a newer backend.
    assert await names(metadata="bogus") == ["with.png", "without.png"]
    # Case does not matter.
    assert await names(metadata="WITH") == ["with.png"]


async def test_rating_accepts_a_post_body(service, tmp_path):
    image_path = str(tmp_path / "output" / "a.png")
    response = await GalleryHandlerSet().set_rating(
        FakeRequest(method="POST", body={"image_path": image_path, "rating": 1})
    )
    assert response.status == 200
    assert _payload(response)["data"] == {"image_path": image_path, "rating": 1}
    listed = await service.list_images()
    assert listed["items"][0]["rating"] == 1


async def test_rating_accepts_query_params_for_get(service, tmp_path):
    image_path = str(tmp_path / "output" / "a.png")
    response = await GalleryHandlerSet().set_rating(
        FakeRequest(query={"image_path": image_path, "rating": "-1"})
    )
    assert response.status == 200
    assert _payload(response)["data"]["rating"] == -1


@pytest.mark.parametrize(
    "request_kwargs, expected_status",
    [
        ({"body": {"rating": 1}}, 400),
        ({"body": {"image_path": "/x.png"}}, 400),
        ({"body": {"image_path": "/x.png", "rating": 9}}, 400),
        ({"body": {"image_path": "/x.png", "rating": "abc"}}, 400),
    ],
)
async def test_rating_validation(service, request_kwargs, expected_status):
    response = await GalleryHandlerSet().set_rating(FakeRequest(method="POST", **request_kwargs))
    assert response.status == expected_status
    assert _payload(response)["success"] is False


async def test_rating_unknown_image_is_a_404(service):
    response = await GalleryHandlerSet().set_rating(
        FakeRequest(method="POST", body={"image_path": "/not/indexed.png", "rating": 1})
    )
    assert response.status == 404


async def test_stats_endpoint_reports_unknown_totals(service):
    response = await GalleryHandlerSet().get_stats(FakeRequest(query={"by": "artist"}))
    body = _payload(response)
    assert body["success"] is True
    assert body["data"]["by"] == "artist"
    assert body["data"]["totals"]["images"] == 1
    assert body["data"]["items"][0]["key"] == "nnn yryr"


async def test_stats_endpoint_accepts_by_lora(service):
    response = await GalleryHandlerSet().get_stats(FakeRequest(query={"by": "lora"}))
    assert _payload(response)["data"]["by"] == "lora"


async def test_serve_image_forbids_paths_outside_the_output_directory(service, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path / "output"))
    handler = GalleryHandlerSet()
    with pytest.raises(web.HTTPForbidden):
        await handler.serve_image(FakeRequest(query={"path": r"C:\Windows\win.ini"}))
    with pytest.raises(web.HTTPForbidden):
        await handler.serve_image(FakeRequest(query={"path": ""}))


async def test_index_start_reports_already_running(service, monkeypatch):
    async def _running():
        return {"started": False, "reason": "already_running"}

    monkeypatch.setattr(service, "start_index", lambda **kwargs: _running())
    response = await GalleryHandlerSet().start_index(FakeRequest(method="POST", body={"force": True}))
    assert _payload(response)["data"]["reason"] == "already_running"


async def test_index_status_and_config_shapes(service, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path / "output"))
    handler = GalleryHandlerSet()

    status_body = _payload(await handler.get_index_status(FakeRequest()))
    assert status_body["success"] is True
    assert status_body["data"]["running"] is False
    assert status_body["data"]["stage"] == "idle"

    config_body = _payload(await handler.get_config(FakeRequest()))
    assert config_body["success"] is True
    assert config_body["data"]["output_path_source"] == "setting"
    assert config_body["data"]["indexed_images"] == 1


def test_gallery_handler_set_is_a_frozen_dataclass():
    import dataclasses

    assert dataclasses.is_dataclass(GalleryHandlerSet)
    with pytest.raises(dataclasses.FrozenInstanceError):
        GalleryHandlerSet().cache = None
