"""Tests for the gallery thumbnail cache."""

from __future__ import annotations

import os

import pytest
from PIL import Image

from py.services.gallery.thumbnails import ThumbnailService


@pytest.fixture(autouse=True)
def _fresh_cache(tmp_path, monkeypatch):
    ThumbnailService.reset_instance()
    monkeypatch.setenv("LORA_MANAGER_THUMBNAIL_DIR", str(tmp_path / "thumbs"))
    yield
    ThumbnailService.reset_instance()


def _noisy_image(path, size=(1200, 1600)):
    """Noise compresses badly, which is what makes a real photo expensive."""
    image = Image.effect_noise(size, 120).convert("RGB")
    image.save(path)
    return str(path)


def test_generates_a_cached_webp_thumbnail(tmp_path):
    source = _noisy_image(tmp_path / "big.png")

    thumb = ThumbnailService.get_instance().get(source, 128)

    assert thumb is not None
    assert thumb.endswith(".webp")
    assert os.path.isfile(thumb)
    assert os.path.getsize(thumb) < os.path.getsize(source)
    with Image.open(thumb) as image:
        assert max(image.size) <= 128


def test_reuses_the_cached_thumbnail(tmp_path):
    source = _noisy_image(tmp_path / "big.png")
    service = ThumbnailService.get_instance()

    first = service.get(source, 128)
    stamp = os.stat(first).st_mtime_ns
    second = service.get(source, 128)

    assert second == first
    assert os.stat(second).st_mtime_ns == stamp


def test_different_sizes_are_cached_separately(tmp_path):
    source = _noisy_image(tmp_path / "big.png")
    service = ThumbnailService.get_instance()

    small = service.get(source, 128)
    large = service.get(source, 512)

    assert small != large
    with Image.open(small) as image:
        assert max(image.size) <= 128
    with Image.open(large) as image:
        assert max(image.size) <= 512


def test_a_missing_file_yields_no_thumbnail(tmp_path):
    assert ThumbnailService.get_instance().get(str(tmp_path / "nope.png"), 128) is None


def test_a_broken_image_yields_no_thumbnail(tmp_path):
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"definitely not an image")

    assert ThumbnailService.get_instance().get(str(broken), 128) is None
