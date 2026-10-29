"""Tests for the animadex.net artist-preview lookup."""

from __future__ import annotations

import pytest

from py.services.gallery import artist_previews
from py.services.gallery.artist_previews import ArtistPreviewService


class _FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status

    async def json(self, content_type=None):
        return self._payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    """Stands in for ``aiohttp.ClientSession`` so no test touches the network."""

    payload = {"results": []}
    status = 200
    error = None
    calls = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def get(self, url, params=None, headers=None):
        _FakeSession.calls.append((url, params))
        if _FakeSession.error is not None:
            raise _FakeSession.error
        return _FakeResponse(_FakeSession.payload, _FakeSession.status)


@pytest.fixture(autouse=True)
def _offline_upstream(monkeypatch):
    ArtistPreviewService.reset_instance()
    _FakeSession.calls = []
    _FakeSession.payload = {"results": []}
    _FakeSession.status = 200
    _FakeSession.error = None
    monkeypatch.setattr(artist_previews.aiohttp, "ClientSession", _FakeSession)
    yield
    ArtistPreviewService.reset_instance()


async def test_prefers_the_exact_artist_match():
    _FakeSession.payload = {
        "results": [
            {
                "name": "Kedama Milk Co",
                "trigger": "kedama_milk_co",
                "thumb_url": "https://cdn/kedama.webp",
                "count": 628,
            },
            {"name": "Kedama", "trigger": "kedama milk", "thumb_url": "https://cdn/exact.webp", "count": 12},
        ]
    }

    result = await ArtistPreviewService.get_instance().get("kedama milk")

    assert result["thumb_url"] == "https://cdn/exact.webp"
    assert result["matched_name"] == "Kedama"
    assert result["count"] == 12
    assert _FakeSession.calls[0][1]["q"] == "kedama milk"


async def test_caches_the_answer_for_later_renders():
    _FakeSession.payload = {
        "results": [{"name": "wlop", "trigger": "wlop", "thumb_url": "https://cdn/wlop.webp", "count": 364}]
    }
    service = ArtistPreviewService.get_instance()

    first = await service.get("wlop")
    second = await service.get("WLOP")

    assert first["thumb_url"] == second["thumb_url"] == "https://cdn/wlop.webp"
    assert len(_FakeSession.calls) == 1


async def test_degrades_to_an_empty_preview_on_http_errors():
    _FakeSession.status = 429

    result = await ArtistPreviewService.get_instance().get("wlop")

    assert result["thumb_url"] == ""
    assert result["artist"] == "wlop"


async def test_degrades_to_an_empty_preview_on_network_errors():
    _FakeSession.error = RuntimeError("boom")

    result = await ArtistPreviewService.get_instance().get("wlop")

    assert result["thumb_url"] == ""


async def test_degrades_when_upstream_has_no_thumbnail():
    _FakeSession.payload = {"results": [{"name": "nobody", "thumb_url": ""}]}

    result = await ArtistPreviewService.get_instance().get("nobody")

    assert result["thumb_url"] == ""


async def test_a_blank_name_never_hits_the_network():
    result = await ArtistPreviewService.get_instance().get("   ")

    assert result["thumb_url"] == ""
    assert _FakeSession.calls == []
