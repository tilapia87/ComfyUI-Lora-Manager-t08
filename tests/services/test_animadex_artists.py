"""Tests for the animadex artist membership index."""

from __future__ import annotations

import json
import time

import pytest

from py.services.gallery import animadex_artists
from py.services.gallery.animadex_artists import AnimadexArtistIndex

PAGE_SIZE = animadex_artists._UPSTREAM_PAGE_SIZE


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
    """Serves synthetic artist-search pages so no test touches the network."""

    names = []
    fail_pages = set()
    error = None
    calls = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def get(self, url, params=None, headers=None):
        page = int((params or {}).get("page") or 1)
        _FakeSession.calls.append((url, page))
        if _FakeSession.error is not None:
            raise _FakeSession.error
        if page in _FakeSession.fail_pages:
            return _FakeResponse({}, status=503)
        start = (page - 1) * PAGE_SIZE
        chunk = _FakeSession.names[start : start + PAGE_SIZE]
        payload = {
            "total": len(_FakeSession.names),
            "page": page,
            "page_size": PAGE_SIZE,
            "pages": max(1, (len(_FakeSession.names) + PAGE_SIZE - 1) // PAGE_SIZE),
            "results": [{"name": name, "trigger": name.lower(), "slug": name.replace(" ", "_")} for name in chunk],
        }
        return _FakeResponse(payload)


@pytest.fixture(autouse=True)
def _offline_upstream(monkeypatch, tmp_path):
    AnimadexArtistIndex.reset_instance()
    _FakeSession.names = []
    _FakeSession.fail_pages = set()
    _FakeSession.error = None
    _FakeSession.calls = []
    monkeypatch.setattr(animadex_artists.aiohttp, "ClientSession", _FakeSession)
    (tmp_path / "cache").mkdir()
    yield tmp_path / "cache" / "animadex_artists.json"
    AnimadexArtistIndex.reset_instance()


def _index(cache_path):
    return AnimadexArtistIndex(cache_path=str(cache_path))


async def _build(index, timeout=5.0):
    assert await index.ensure_loaded(wait_seconds=timeout) is True


def _write_cache(path, names, fetched_at):
    path.write_text(json.dumps({"fetched_at": fetched_at, "count": len(names), "names": names}), encoding="utf-8")


async def test_builds_the_index_from_every_page(_offline_upstream):
    _FakeSession.names = [f"artist number {n}" for n in range(PAGE_SIZE * 2 + 5)]
    index = _index(_offline_upstream)

    await _build(index)

    assert len(_FakeSession.calls) == 3
    assert index.status()["count"] == len(_FakeSession.names)
    assert index.contains("artist number 0")
    assert index.contains("artist number 40")
    assert index.contains("artist number 76")
    assert not index.contains("nobody")


async def test_matches_artists_regardless_of_case_and_separators(_offline_upstream):
    _FakeSession.names = ["Kedama Milk Co"]
    index = _index(_offline_upstream)

    await _build(index)

    assert index.contains("kedama milk co")
    assert index.contains("KEDAMA_MILK_CO")
    assert not index.contains("   ")


async def test_a_fresh_cache_skips_the_network(_offline_upstream):
    _write_cache(_offline_upstream, ["cached artist"], time.time())
    _FakeSession.names = ["fresh artist"]
    index = _index(_offline_upstream)

    await _build(index)

    assert _FakeSession.calls == []
    assert index.contains("cached artist")
    assert not index.contains("fresh artist")


async def test_a_stale_cache_is_replaced_by_a_refresh(_offline_upstream):
    _write_cache(_offline_upstream, ["old artist"], time.time() - 8 * 24 * 3600)
    _FakeSession.names = ["new artist", "second artist"]
    index = _index(_offline_upstream)

    await _build(index)

    assert _FakeSession.calls
    assert index.contains("new artist")
    assert not index.contains("old artist")
    payload = json.loads(_offline_upstream.read_text(encoding="utf-8"))
    assert payload["count"] == 2
    assert payload["fetched_at"] > 0


async def test_a_failed_refresh_falls_back_to_the_stale_cache(_offline_upstream):
    _write_cache(_offline_upstream, ["cached artist"], time.time() - 8 * 24 * 3600)
    _FakeSession.error = RuntimeError("boom")
    index = _index(_offline_upstream)

    assert await index.ensure_loaded(wait_seconds=5.0) is True

    assert index.contains("cached artist")
    status = index.status()
    assert status["error"]
    assert status["ready"] is True


async def test_a_failed_build_without_a_cache_reports_the_error(_offline_upstream):
    _FakeSession.error = RuntimeError("boom")
    index = _index(_offline_upstream)

    assert await index.ensure_loaded(wait_seconds=5.0) is False

    status = index.status()
    assert status["ready"] is False
    assert status["error"]
    assert index.contains("cached artist") is False


async def test_one_broken_page_does_not_lose_the_other_pages(_offline_upstream):
    _FakeSession.names = [f"artist number {n}" for n in range(PAGE_SIZE * 2)]
    _FakeSession.fail_pages = {2}
    index = _index(_offline_upstream)

    await _build(index)

    assert index.contains("artist number 0")
    assert not index.contains("artist number 40")
    assert index.status()["ready"] is True


async def test_the_first_build_runs_once_for_concurrent_callers(_offline_upstream):
    _FakeSession.names = ["solo artist"]
    index = _index(_offline_upstream)

    first, second = await _gather(index)

    assert first is True and second is True
    assert len(_FakeSession.calls) == 1


async def _gather(index):
    import asyncio

    return await asyncio.gather(
        index.ensure_loaded(wait_seconds=5.0),
        index.ensure_loaded(wait_seconds=5.0),
    )
