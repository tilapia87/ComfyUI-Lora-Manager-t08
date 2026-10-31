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


@pytest.fixture
def lora_hash_service(tmp_path, monkeypatch):
    """Two images that both used the same locally installed LoRA."""
    cache = GalleryCache(str(tmp_path / "gallery.sqlite"))

    def _record(name):
        return {
            "image_path": str(tmp_path / "output" / name),
            "file_name": name,
            "mtime": 1.0,
            "size": 10,
            "width": 8,
            "height": 8,
            "prompt": "1girl, @nnn yryr",
            "negative_prompt": None,
            "parser": "comfy",
            "gen_params": {},
            "has_metadata": True,
            "artists": [],
            "loras": [
                {
                    "name": "style_a.safetensors",
                    "weight": 0.8,
                    "exists_locally": True,
                    "hash": "a" * 64,
                }
            ],
        }

    cache.upsert_images([_record("a.png"), _record("b.png")])
    instance = GalleryService(cache=cache)
    monkeypatch.setattr(GalleryService, "_instance", instance)
    return instance


async def test_list_endpoint_exposes_the_resolved_lora_hash(lora_hash_service):
    """The frontend decides whether a chip is linkable from this field."""
    body = _payload(await GalleryHandlerSet().list_images(FakeRequest(query={})))
    entry = body["data"]["items"][0]["loras"][0]
    assert entry["hash"] == "a" * 64
    assert entry["exists_locally"] is True


async def test_for_lora_endpoint_requires_a_key(lora_hash_service):
    # Asking for nothing must not silently mean "every image".
    response = await GalleryHandlerSet().list_images_for_lora(FakeRequest(query={}))
    assert response.status == 400
    assert _payload(response)["success"] is False


async def test_for_lora_endpoint_returns_images_and_a_summary(lora_hash_service):
    response = await GalleryHandlerSet().list_images_for_lora(
        FakeRequest(query={"hash": "a" * 64})
    )
    assert response.status == 200
    data = _payload(response)["data"]
    assert data["total"] == 2
    assert data["lora"] == {"name": None, "hash": "a" * 64}
    assert set(data["summary"]) == {
        "total",
        "liked",
        "disliked",
        "unrated",
        "net",
        "loved",
        "hated",
        "score",
        "levels",
    }
    assert data["summary"]["unrated"] == 2
    assert data["summary"]["levels"] == {"love": 0, "like": 0, "dislike": 0, "hate": 0}
    for item in data["items"]:
        assert item["image_url"].startswith("/api/lm/gallery/image?path=")


async def test_for_lora_endpoint_falls_back_to_a_name(lora_hash_service):
    data = _payload(
        await GalleryHandlerSet().list_images_for_lora(
            FakeRequest(query={"name": "style_a.safetensors"})
        )
    )["data"]
    assert data["total"] == 2
    assert data["lora"]["name"] == "style_a.safetensors"


async def test_for_lora_endpoint_is_empty_for_an_unknown_lora(lora_hash_service):
    response = await GalleryHandlerSet().list_images_for_lora(
        FakeRequest(query={"hash": "f" * 64})
    )
    assert response.status == 200
    body = _payload(response)
    assert body["success"] is True
    assert body["data"]["total"] == 0
    assert body["data"]["items"] == []


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


@pytest.mark.parametrize("rating", [3, -3])
async def test_rating_accepts_the_strong_levels(service, tmp_path, rating):
    image_path = str(tmp_path / "output" / "a.png")
    response = await GalleryHandlerSet().set_rating(
        FakeRequest(method="POST", body={"image_path": image_path, "rating": rating})
    )
    assert response.status == 200
    assert _payload(response)["data"]["rating"] == rating
    listed = await service.list_images()
    assert listed["items"][0]["rating"] == rating


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


async def test_summary_endpoint_returns_the_contract_shape(service):
    response = await GalleryHandlerSet().get_summary(FakeRequest())
    assert response.status == 200
    body = _payload(response)
    assert body["success"] is True
    data = body["data"]
    assert set(data) == {
        "images",
        "rated",
        "unrated",
        "liked",
        "disliked",
        "loved",
        "hated",
        "score",
        "net",
        "levels",
        "like_ratio",
    }
    # The fixture indexes one image and rates none of them.
    assert data["images"] == 1
    assert data["rated"] == 0 and data["unrated"] == 1
    assert data["like_ratio"] is None
    assert data["levels"] == {"love": 0, "like": 0, "dislike": 0, "hate": 0}


async def test_summary_endpoint_reports_a_failure(service, monkeypatch):
    async def _boom():
        raise RuntimeError("cache unavailable")

    monkeypatch.setattr(service, "summary", _boom)
    response = await GalleryHandlerSet().get_summary(FakeRequest())
    assert response.status == 500
    assert _payload(response) == {"success": False, "error": "cache unavailable"}


def test_summary_route_is_registered():
    paths = {(definition.method, definition.path) for definition in ROUTE_DEFINITIONS}
    assert ("GET", "/api/lm/gallery/summary") in paths
    assert "get_gallery_summary" in GalleryHandlerSet().to_route_mapping()


async def test_stats_endpoint_forwards_paging_parameters(service):
    response = await GalleryHandlerSet().get_stats(
        FakeRequest(query={"by": "artist", "limit": "1", "offset": "1"})
    )
    data = _payload(response)["data"]
    assert data["limit"] == 1
    assert data["offset"] == 1
    assert data["total"] == len(data["items"]) + 1


async def test_stats_endpoint_defaults_and_clamps_the_offset(service):
    default = _payload(await GalleryHandlerSet().get_stats(FakeRequest(query={"by": "artist"})))["data"]
    assert default["offset"] == 0
    assert default["limit"] == 200

    negative = _payload(
        await GalleryHandlerSet().get_stats(FakeRequest(query={"by": "artist", "offset": "-5"}))
    )["data"]
    assert negative["offset"] == 0

    garbage = _payload(
        await GalleryHandlerSet().get_stats(FakeRequest(query={"by": "artist", "offset": "abc"}))
    )["data"]
    assert garbage["offset"] == 0


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


async def test_artist_preview_requires_a_name(service):
    response = await GalleryHandlerSet().get_artist_preview(FakeRequest(query={}))
    assert response.status == 400
    assert _payload(response)["success"] is False


async def test_artist_preview_proxies_the_lookup(service, monkeypatch):
    from py.services.gallery.artist_previews import ArtistPreviewService

    async def _lookup(artist):
        return {
            "artist": artist,
            "matched_name": "Kedama Milk",
            "thumb_url": "https://blobs.animadex.net/ArtistOutputs/thumbs/kedama%20milk.webp",
            "page_url": "https://danbooru.donmai.us/posts?tags=kedama_milk",
            "count": 628,
        }

    monkeypatch.setattr(ArtistPreviewService, "_lookup", lambda self, artist: _lookup(artist))
    ArtistPreviewService.reset_instance()
    try:
        response = await GalleryHandlerSet().get_artist_preview(
            FakeRequest(query={"name": "kedama milk"})
        )
        data = _payload(response)["data"]
        assert data["thumb_url"].startswith("https://blobs.animadex.net/")
        assert data["matched_name"] == "Kedama Milk"
        assert data["count"] == 628
    finally:
        ArtistPreviewService.reset_instance()


def test_artist_preview_route_is_registered():
    paths = {(definition.method, definition.path) for definition in ROUTE_DEFINITIONS}
    assert ("GET", "/api/lm/gallery/artist-preview") in paths
    assert "get_gallery_artist_preview" in GalleryHandlerSet().to_route_mapping()


async def test_thumbnail_endpoint_serves_a_webp(service, tmp_path, monkeypatch):
    from PIL import Image

    from py.services.gallery.thumbnails import ThumbnailService

    ThumbnailService.reset_instance()
    monkeypatch.setenv("LORA_MANAGER_THUMBNAIL_DIR", str(tmp_path / "thumbs"))
    try:
        output = tmp_path / "output"
        output.mkdir(exist_ok=True)
        image_path = output / "shot.png"
        Image.new("RGB", (600, 900), (12, 120, 200)).save(image_path)
        get_settings_manager().set("gallery_output_path", str(output))

        response = await GalleryHandlerSet().serve_thumbnail(
            FakeRequest(query={"path": str(image_path), "size": "128"})
        )

        assert response.headers.get("Content-Type") == "image/webp"
        assert response.headers.get("Cache-Control")
    finally:
        ThumbnailService.reset_instance()


async def test_thumbnail_endpoint_rejects_paths_outside_the_output_directory(service, tmp_path):
    get_settings_manager().set("gallery_output_path", str(tmp_path / "output"))

    with pytest.raises(web.HTTPForbidden):
        await GalleryHandlerSet().serve_thumbnail(
            FakeRequest(query={"path": r"C:\Windows\win.ini"})
        )
    with pytest.raises(web.HTTPForbidden):
        await GalleryHandlerSet().serve_thumbnail(FakeRequest(query={"path": ""}))


def test_thumbnail_route_is_registered():
    paths = {(definition.method, definition.path) for definition in ROUTE_DEFINITIONS}
    assert ("GET", "/api/lm/gallery/thumbnail") in paths
    assert "serve_gallery_thumbnail" in GalleryHandlerSet().to_route_mapping()


async def test_list_images_carries_a_thumbnail_url(service):
    data = _payload(await GalleryHandlerSet().list_images(FakeRequest(query={})))["data"]

    assert data["items"][0]["thumb_url"].startswith("/api/lm/gallery/thumbnail?path=")
    assert "size=" in data["items"][0]["thumb_url"]


async def test_list_images_forwards_the_order(service, monkeypatch):
    captured = {}

    async def _list(**kwargs):
        captured.update(kwargs)
        return {"items": [], "total": 0, "page": 1, "page_size": 40, "total_pages": 0}

    monkeypatch.setattr(service, "list_images", _list)

    await GalleryHandlerSet().list_images(FakeRequest(query={"order": "asc"}))

    assert captured["order"] == "asc"


async def test_stats_endpoint_forwards_the_order(service, monkeypatch):
    captured = {}

    async def _stats(**kwargs):
        captured.update(kwargs)
        return {"by": "artist", "totals": {}, "total": 0, "offset": 0, "limit": 200, "items": []}

    monkeypatch.setattr(service, "stats", _stats)

    await GalleryHandlerSet().get_stats(FakeRequest(query={"order": "asc"}))

    assert captured["order"] == "asc"


async def test_stats_endpoint_forwards_the_animadex_filter(service, monkeypatch):
    captured = {}

    async def _stats(**kwargs):
        captured.update(kwargs)
        return {
            "by": "artist",
            "totals": {},
            "total": 0,
            "offset": 0,
            "limit": 200,
            "items": [],
            "animadex": {"ready": True, "loading": False, "count": 15879, "error": ""},
        }

    monkeypatch.setattr(service, "stats", _stats)
    handler = GalleryHandlerSet()

    body = _payload(await handler.get_stats(FakeRequest(query={"animadex_only": "true"})))
    assert captured["animadex_only"] is True
    assert body["data"]["animadex"]["count"] == 15879

    await handler.get_stats(FakeRequest(query={}))
    assert captured["animadex_only"] is False

    # The frontend sends "1"; anything unrecognised stays off.
    await handler.get_stats(FakeRequest(query={"animadex_only": "bogus"}))
    assert captured["animadex_only"] is False


def test_thumbnail_cache_routes_are_registered():
    paths = {(definition.method, definition.path) for definition in ROUTE_DEFINITIONS}
    assert ("GET", "/api/lm/gallery/thumbnail-cache") in paths
    assert ("POST", "/api/lm/gallery/thumbnail-cache/clear") in paths
    mapping = GalleryHandlerSet().to_route_mapping()
    assert "get_gallery_thumbnail_cache" in mapping
    assert "clear_gallery_thumbnail_cache" in mapping


async def test_thumbnail_cache_info_and_clear(service, tmp_path, monkeypatch):
    from PIL import Image

    from py.services.gallery.thumbnails import ThumbnailService

    ThumbnailService.reset_instance()
    monkeypatch.setenv("LORA_MANAGER_THUMBNAIL_DIR", str(tmp_path / "thumbs"))
    try:
        output = tmp_path / "output"
        output.mkdir(exist_ok=True)
        image_path = output / "shot.png"
        Image.new("RGB", (400, 600), (5, 90, 150)).save(image_path)
        get_settings_manager().set("gallery_output_path", str(output))

        await GalleryHandlerSet().serve_thumbnail(
            FakeRequest(query={"path": str(image_path), "size": "128"})
        )

        info = _payload(await GalleryHandlerSet().get_thumbnail_cache(FakeRequest()))["data"]
        assert info["count"] == 1
        assert info["bytes"] > 0
        assert info["size"] >= 64
        assert info["directory"]

        cleared = _payload(await GalleryHandlerSet().clear_thumbnail_cache(FakeRequest()))["data"]
        assert cleared["removed"] == 1

        after = _payload(await GalleryHandlerSet().get_thumbnail_cache(FakeRequest()))["data"]
        assert after["count"] == 0
    finally:
        ThumbnailService.reset_instance()


def test_gallery_handler_set_is_a_frozen_dataclass():
    import dataclasses

    assert dataclasses.is_dataclass(GalleryHandlerSet)
    with pytest.raises(dataclasses.FrozenInstanceError):
        GalleryHandlerSet().cache = None
