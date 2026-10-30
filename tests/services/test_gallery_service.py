"""Tests for the gallery service: scanning, ratings, statistics, containment."""

from __future__ import annotations

import asyncio
import json
import os

import pytest
from PIL import Image, PngImagePlugin

from py.services.gallery.gallery_cache import GalleryCache
from py.services.gallery.gallery_indexer import (
    detect_parser,
    iter_image_paths,
    resolve_output_dir,
)
from py.services.gallery.gallery_service import GalleryService, _is_within_root
from py.services.settings_manager import get_settings_manager

# A ComfyUI API graph shaped like a real Anima workflow: checkpoint, a LoraLoader,
# a LoraLoaderModelOnly (which the recipe parser does NOT handle), a positive
# prompt carrying an artist tag, and an Anima-style negative prompt.
COMFY_GRAPH = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "anima-base-v1.0.safetensors"}},
    "2": {
        "class_type": "LoraLoader",
        "inputs": {
            "model": ["1", 0],
            "clip": ["1", 1],
            "lora_name": "style_a.safetensors",
            "strength_model": 0.8,
            "strength_clip": 0.8,
        },
    },
    "3": {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {"model": ["2", 0], "lora_name": "style_b.safetensors", "strength_model": 0.5},
    },
    "4": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "masterpiece, best quality, 1girl, @nnn yryr, smile", "clip": ["2", 1]},
    },
    "5": {
        "class_type": "CLIPTextEncode",
        "inputs": {"text": "worst quality, low quality, artist name", "clip": ["2", 1]},
    },
    "6": {"class_type": "EmptyLatentImage", "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
    "7": {
        "class_type": "KSampler",
        "inputs": {
            "model": ["3", 0],
            "positive": ["4", 0],
            "negative": ["5", 0],
            "latent_image": ["6", 0],
            "seed": 42,
            "steps": 30,
            "cfg": 4.5,
            "sampler_name": "er_sde",
            "scheduler": "simple",
            "denoise": 1.0,
        },
    },
}

A1111_PARAMETERS = (
    "masterpiece, 1girl, @heripantomorrow, solo\n"
    "Negative prompt: worst quality, artist name, blurry\n"
    "Steps: 28, Sampler: Euler a, CFG scale: 5, Seed: 12345, Size: 832x1216, Model: anima_aesthetic"
)


def _write_png(path, key: str, text: str, size=(64, 96)) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    info = PngImagePlugin.PngInfo()
    info.add_text(key, text)
    Image.new("RGB", size, (30, 30, 40)).save(path, pnginfo=info)
    return str(path)


@pytest.fixture(autouse=True)
def _fast_lora_lookup(monkeypatch):
    """Skip the LoRA scanner round-trip; availability is cosmetic in tests."""

    async def _empty(self):
        return set()

    monkeypatch.setattr(GalleryService, "_collect_known_loras", _empty)


@pytest.fixture
def artist_list(tmp_path):
    path = tmp_path / "artists.txt"
    path.write_text("nnn yryr\nheripantomorrow\n", encoding="utf-8")
    return str(path)


@pytest.fixture
def output_dir(tmp_path):
    """An output directory with two metadata-carrying images and one plain one."""
    root = tmp_path / "output"
    _write_png(root / "comfy_00001_.png", "prompt", json.dumps(COMFY_GRAPH))
    _write_png(root / "a1111_00002_.png", "parameters", A1111_PARAMETERS)
    (root / "sub").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 32), (10, 10, 10)).save(root / "sub" / "plain.png")
    return str(root)


@pytest.fixture
def service(tmp_path, output_dir, artist_list):
    settings = get_settings_manager()
    settings.set("gallery_output_path", output_dir)
    settings.set("gallery_artist_list_path", artist_list)
    settings.set("gallery_recursive", True)
    return GalleryService(cache=GalleryCache(str(tmp_path / "gallery.sqlite")))


async def _scan(service: GalleryService, *, force: bool = True) -> dict:
    started = await service.start_index(force=force)
    assert started["started"] is True, started
    for _ in range(400):
        if not service.is_running():
            break
        await asyncio.sleep(0.01)
    assert not service.is_running(), "scan did not finish"
    return service.get_status()


def _by_name(items):
    return {item["file_name"]: item for item in items}


# ------------------------------------------------------------------ scanning


async def test_scan_indexes_comfy_and_a1111_images(service):
    status = await _scan(service)
    assert status["stage"] == "completed"
    assert status["total"] == 3
    assert status["added"] == 3
    assert status["failed"] == 0

    items = _by_name((await service.list_images())["items"])

    comfy = items["comfy_00001_.png"]
    assert comfy["parser"] == "comfy"
    assert comfy["has_metadata"] is True
    # Dimensions describe the actual file; the latent size stays in gen_params.
    assert comfy["width"] == 64 and comfy["height"] == 96
    assert comfy["gen_params"]["seed"] == 42
    assert comfy["gen_params"]["steps"] == 30
    assert "prompt" not in comfy["gen_params"]
    assert "negative" not in comfy["gen_params"]
    assert comfy["artists"] == [{"name": "nnn yryr", "canonical": "nnn yryr", "known": True}]
    # Both LoRA loaders are found, including LoraLoaderModelOnly.
    assert {lora["name"] for lora in comfy["loras"]} == {"style_a.safetensors", "style_b.safetensors"}
    assert {lora["weight"] for lora in comfy["loras"]} == {0.8, 0.5}

    a1111 = items["a1111_00002_.png"]
    assert a1111["parser"] == "automatic"
    assert a1111["artists"][0]["canonical"] == "heripantomorrow"

    plain = items["plain.png"]
    assert plain["has_metadata"] is False
    assert plain["artists"] == []
    assert plain["parser"] is None


async def test_negative_prompt_does_not_invent_an_artist(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    names = {artist["canonical"] for item in items.values() for artist in item["artists"]}
    assert names == {"nnn yryr", "heripantomorrow"}


async def test_rescan_without_changes_reparses_nothing(service):
    await _scan(service)
    status = await _scan(service, force=False)
    assert status["added"] == 0
    assert status["updated"] == 0
    assert (await service.list_images())["total"] == 3


async def test_non_recursive_scan_skips_subfolders_without_pruning_them(service):
    await _scan(service)
    get_settings_manager().set("gallery_recursive", False)

    status = await _scan(service)
    assert status["total"] == 2
    # The nested image is untouched: its rating must survive a narrower scan.
    assert (await service.list_images())["total"] == 3


async def test_deleted_image_is_pruned_and_others_keep_their_rating(service, output_dir):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["a1111_00002_.png"]["image_path"], 1)
    await service.set_rating(items["comfy_00001_.png"]["image_path"], -1)

    os.remove(os.path.join(output_dir, "comfy_00001_.png"))
    status = await _scan(service)
    assert status["removed"] == 1

    remaining = _by_name((await service.list_images())["items"])
    assert set(remaining) == {"a1111_00002_.png", "plain.png"}
    assert remaining["a1111_00002_.png"]["rating"] == 1


async def test_scan_reports_missing_output_directory(tmp_path):
    settings = get_settings_manager()
    settings.set("gallery_output_path", str(tmp_path / "nowhere"))
    service = GalleryService(cache=GalleryCache(str(tmp_path / "g.sqlite")))
    status = await _scan(service)
    assert status["stage"] == "error"
    assert status["error"] == "output_directory_not_found"


async def test_a_failing_preparation_step_ends_the_job(service, monkeypatch):
    """A corrupt user file must not leave the scan marked as running forever.

    Loading the artist list happens before the walk, so if it raised outside the
    job's try block the status stayed on ``running`` and the progress bar span
    for good. ``_scan`` fails with "scan did not finish" if that regresses.
    """
    import py.services.gallery.gallery_service as gallery_service

    def _boom(*args, **kwargs):
        raise RuntimeError("corrupt artist list")

    monkeypatch.setattr(gallery_service, "load_gallery_artist_index", _boom)
    status = await _scan(service)
    assert status["stage"] == "error"
    assert status["running"] is False
    assert "corrupt artist list" in (status["error"] or "")


async def test_concurrent_scan_is_refused(service, monkeypatch):
    started = await service.start_index(force=True)
    assert started == {"started": True}
    second = await service.start_index(force=True)
    assert second == {"started": False, "reason": "already_running"}
    for _ in range(400):
        if not service.is_running():
            break
        await asyncio.sleep(0.01)


# ------------------------------------------------------------------ ratings


async def test_ratings_survive_a_forced_rescan(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    comfy_path = items["comfy_00001_.png"]["image_path"]
    await service.set_rating(comfy_path, 1)

    await _scan(service, force=True)

    after = _by_name((await service.list_images())["items"])
    assert after["comfy_00001_.png"]["rating"] == 1


async def test_set_rating_rejects_unknown_images_and_bad_values(service):
    await _scan(service)
    assert await service.set_rating("/not/indexed.png", 1) is False
    with pytest.raises(ValueError):
        await service.set_rating("/not/indexed.png", 5)
    with pytest.raises(ValueError):
        await service.set_rating("/not/indexed.png", -2)


@pytest.mark.parametrize("rating", [3, 1, -1, -3, 0])
async def test_every_valid_rating_round_trips(service, rating):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    path = items["comfy_00001_.png"]["image_path"]
    assert await service.set_rating(path, rating) is True
    after = _by_name((await service.list_images())["items"])
    assert after["comfy_00001_.png"]["rating"] == rating


# --------------------------------------------------------------- statistics


async def test_statistics_aggregate_per_artist_and_per_lora(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 1)
    await service.set_rating(items["a1111_00002_.png"]["image_path"], -1)

    artist_stats = await service.stats(by="artist")
    assert artist_stats["totals"] == {
        "images": 3,
        "rated": 2,
        "unrated": 1,
        "liked": 1,
        "disliked": 1,
        "loved": 0,
        "hated": 0,
        "score": 0,
        "net": 0,
        "levels": {"love": 0, "like": 1, "dislike": 1, "hate": 0},
        "like_ratio": 0.5,
    }
    rows = {row["key"]: row for row in artist_stats["items"]}
    assert rows["nnn yryr"]["likes"] == 1 and rows["nnn yryr"]["net"] == 1
    assert rows["nnn yryr"]["score"] == 1
    assert rows["nnn yryr"]["levels"] == {"love": 0, "like": 1, "dislike": 0, "hate": 0}
    assert rows["nnn yryr"]["like_ratio"] == 1.0 and rows["nnn yryr"]["known"] is True
    assert rows["heripantomorrow"]["dislikes"] == 1 and rows["heripantomorrow"]["net"] == -1
    assert rows["heripantomorrow"]["score"] == -1
    assert rows["heripantomorrow"]["like_ratio"] == 0.0

    lora_stats = await service.stats(by="lora")
    lora_rows = {row["key"]: row for row in lora_stats["items"]}
    assert set(lora_rows) == {"style_a.safetensors", "style_b.safetensors"}

    # Default sort is the weighted score, descending.
    assert [row["key"] for row in artist_stats["items"]][0] == "nnn yryr"

    # An unrated artist reports no ratio rather than a fake 0.
    await service.set_rating(items["a1111_00002_.png"]["image_path"], 0)
    unrated = await service.stats(by="artist", sort="score")
    rows = {row["key"]: row for row in unrated["items"]}
    assert rows["heripantomorrow"]["like_ratio"] is None
    assert rows["heripantomorrow"]["unrated"] == 1


async def test_weighted_score_makes_a_strong_vote_outweigh_a_mild_one(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    # A single +3 must outrank the mild +1 on another artist.
    await service.set_rating(items["a1111_00002_.png"]["image_path"], 3)
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 1)

    stats = await service.stats(by="artist")
    rows = {row["key"]: row for row in stats["items"]}
    assert rows["heripantomorrow"]["score"] == 3
    assert rows["heripantomorrow"]["levels"]["love"] == 1
    assert rows["nnn yryr"]["score"] == 1
    assert rows["nnn yryr"]["levels"]["like"] == 1
    assert stats["totals"]["score"] == 4
    assert stats["totals"]["loved"] == 1
    # The vote counts still report one like per side.
    assert rows["heripantomorrow"]["likes"] == rows["nnn yryr"]["likes"] == 1
    assert [row["key"] for row in stats["items"]][0] == "heripantomorrow"


def _seed_ratings(tmp_path, ratings) -> GalleryService:
    """Index one image per rating, bypassing the scan (summary reads the cache)."""
    cache = GalleryCache(str(tmp_path / "gallery.sqlite"))
    paths = [str(tmp_path / "output" / f"{index}.png") for index in range(len(ratings))]
    cache.upsert_images(
        [
            {
                "image_path": path,
                "file_name": os.path.basename(path),
                "mtime": float(index),
                "size": 10,
                "width": 8,
                "height": 8,
                "has_metadata": False,
                "artists": [],
                "loras": [],
            }
            for index, path in enumerate(paths)
        ]
    )
    for path, rating in zip(paths, ratings):
        assert cache.set_rating(path, rating) is True
    return GalleryService(cache=cache)


def _seed_lora_ratings(
    tmp_path, ratings, lora_name: str = "style_x.safetensors"
) -> GalleryService:
    """One image per rating, all using the same LoRA, without a scan."""
    cache = GalleryCache(str(tmp_path / "gallery.sqlite"))
    paths = [str(tmp_path / "output" / f"{index}.png") for index in range(len(ratings))]
    cache.upsert_images(
        [
            {
                "image_path": path,
                "file_name": os.path.basename(path),
                "mtime": float(index),
                "size": 10,
                "width": 8,
                "height": 8,
                "has_metadata": False,
                "artists": [],
                "loras": [{"name": lora_name, "weight": 0.8, "exists_locally": False}],
            }
            for index, path in enumerate(paths)
        ]
    )
    for path, rating in zip(paths, ratings):
        assert cache.set_rating(path, rating) is True
    return GalleryService(cache=cache)


async def test_summary_counts_every_level_of_the_scale(tmp_path):
    # +3 loved, +1 liked, -1 disliked, -3 hated, and one unrated image.
    service = _seed_ratings(tmp_path, [3, 1, -1, -3, 0])

    assert await service.summary() == {
        "images": 5,
        "rated": 4,
        "unrated": 1,
        "liked": 2,
        "disliked": 2,
        "loved": 1,
        "hated": 1,
        # The two sides cancel out, which the weighted score must show too.
        "score": 0,
        "net": 0,
        "levels": {"love": 1, "like": 1, "dislike": 1, "hate": 1},
        "like_ratio": 0.5,
    }

    # Promoting the unrated image moves it out of `unrated` and into a vote,
    # so the ratio follows the new denominator and the score follows the weight.
    await service.set_rating(str(tmp_path / "output" / "4.png"), 3)
    promoted = await service.summary()
    assert promoted["rated"] == 5 and promoted["unrated"] == 0
    assert promoted["liked"] == 3 and promoted["net"] == 1
    assert promoted["score"] == 3
    assert promoted["levels"]["love"] == 2
    assert promoted["like_ratio"] == 0.6


async def test_summary_reports_no_ratio_before_anything_is_rated(tmp_path):
    empty = GalleryService(cache=GalleryCache(str(tmp_path / "empty.sqlite")))
    summary = await empty.summary()
    assert summary["images"] == 0
    assert summary["rated"] == 0
    assert summary["like_ratio"] is None
    assert summary["levels"] == {"love": 0, "like": 0, "dislike": 0, "hate": 0}

    # Indexed but unrated is "no opinion yet", not a zero ratio.
    unrated = _seed_ratings(tmp_path, [0, 0])
    summary = await unrated.summary()
    assert summary["images"] == 2 and summary["unrated"] == 2
    assert summary["rated"] == 0 and summary["like_ratio"] is None


async def test_statistics_sort_by_exact_level_counts(service):
    """The level sort keys rank by one level, not by the weighted score."""
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 3)
    await service.set_rating(items["a1111_00002_.png"]["image_path"], -3)

    loved = await service.stats(by="artist", sort="loved")
    assert [row["key"] for row in loved["items"]][:2] == ["nnn yryr", "heripantomorrow"]

    hated = await service.stats(by="artist", sort="hated")
    assert [row["key"] for row in hated["items"]][:2] == ["heripantomorrow", "nnn yryr"]


async def test_statistics_min_total_filters_singletons(service):
    await _scan(service)
    assert (await service.stats(by="artist", min_total=2))["items"] == []


async def test_statistics_sort_options(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 1)
    await service.set_rating(items["a1111_00002_.png"]["image_path"], -1)
    for sort in (
        "score",
        "net",
        "likes",
        "dislikes",
        "total",
        "ratio",
        "loved",
        "liked",
        "disliked",
        "hated",
    ):
        rows = (await service.stats(by="artist", sort=sort))["items"]
        assert len(rows) == 2


# ------------------------------------------------------------------ filters


async def test_list_filters_by_rating_artist_lora_and_text(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 1)
    await service.set_rating(items["a1111_00002_.png"]["image_path"], -1)

    assert [i["file_name"] for i in (await service.list_images(rating="liked"))["items"]] == [
        "comfy_00001_.png"
    ]
    assert [i["file_name"] for i in (await service.list_images(rating="disliked"))["items"]] == [
        "a1111_00002_.png"
    ]
    assert (await service.list_images(rating="unrated"))["total"] == 1
    assert (await service.list_images(artist="nnn yryr"))["total"] == 1
    assert (await service.list_images(artist="nobody"))["total"] == 0
    assert (await service.list_images(lora="style_b.safetensors"))["total"] == 1
    assert (await service.list_images(query="style_a"))["total"] == 1
    assert (await service.list_images(query="masterpiece"))["total"] == 2


async def test_rating_filters_cover_both_sides_of_the_four_level_scale(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 3)
    await service.set_rating(items["a1111_00002_.png"]["image_path"], -3)

    loved = await service.list_images(rating="loved")
    assert [item["file_name"] for item in loved["items"]] == ["comfy_00001_.png"]
    hated = await service.list_images(rating="hated")
    assert [item["file_name"] for item in hated["items"]] == ["a1111_00002_.png"]

    # The two sides aggregate the levels they contain, and the previous
    # like/dislike spellings stay as aliases for clients built against them.
    assert (await service.list_images(rating="positive"))["total"] == 1
    assert (await service.list_images(rating="negative"))["total"] == 1
    assert (await service.list_images(rating="liked"))["total"] == 1
    assert (await service.list_images(rating="disliked"))["total"] == 1
    assert (await service.list_images(rating="unrated"))["total"] == 1


async def test_exact_level_filters_isolate_one_level(service):
    """The "like"/"dislike" chips select one exact level each."""
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 3)
    await service.set_rating(items["a1111_00002_.png"]["image_path"], 1)
    await service.set_rating(items["plain.png"]["image_path"], -1)

    liked = await service.list_images(rating="like")
    assert [item["file_name"] for item in liked["items"]] == ["a1111_00002_.png"]
    disliked = await service.list_images(rating="dislike")
    assert [item["file_name"] for item in disliked["items"]] == ["plain.png"]

    # The side aliases keep aggregating both levels, so the exact chips narrow
    # the same set instead of replacing it.
    assert (await service.list_images(rating="positive"))["total"] == 2
    assert (await service.list_images(rating="negative"))["total"] == 1
    assert (await service.list_images(rating="loved"))["total"] == 1

    # The page's -3 facet chip sends "hate": it must narrow the list (here to
    # nothing) instead of falling back to "all".
    assert (await service.list_images(rating="hate"))["total"] == 0
    await service.set_rating(items["plain.png"]["image_path"], -3)
    assert [item["file_name"] for item in (await service.list_images(rating="hate"))["items"]] == [
        "plain.png"
    ]


async def test_pagination_math(service):
    await _scan(service)
    page = await service.list_images(page=2, page_size=2)
    assert page["total"] == 3
    assert page["total_pages"] == 2
    assert len(page["items"]) == 1
    assert page["page"] == 2


async def test_metadata_filter_separates_images_with_and_without_metadata(service):
    # "plain.png" carries no readable generation metadata, so it can never
    # contribute an artist or a LoRA and the user wants to hide it.
    await _scan(service)

    everything = await service.list_images()
    assert everything["total"] == 3

    with_meta = await service.list_images(metadata="with")
    assert sorted(i["file_name"] for i in with_meta["items"]) == [
        "a1111_00002_.png",
        "comfy_00001_.png",
    ]
    assert all(i["has_metadata"] for i in with_meta["items"])

    without_meta = await service.list_images(metadata="without")
    assert [i["file_name"] for i in without_meta["items"]] == ["plain.png"]
    assert without_meta["items"][0]["has_metadata"] is False

    # "all" and an unset value behave identically.
    assert (await service.list_images(metadata="all"))["total"] == 3


async def test_metadata_filter_ignores_an_unknown_value(service):
    await _scan(service)
    assert (await service.list_images(metadata="nonsense"))["total"] == 3


async def test_metadata_filter_combines_with_other_filters(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["plain.png"]["image_path"], 1)

    # The no-metadata image is the only liked one, so the two filters intersect
    # to nothing rather than either one winning.
    assert (await service.list_images(rating="liked", metadata="with"))["total"] == 0
    assert (await service.list_images(rating="liked", metadata="without"))["total"] == 1
    assert (await service.list_images(artist="nnn yryr", metadata="without"))["total"] == 0
    assert (await service.list_images(query="masterpiece", metadata="without"))["total"] == 0


async def test_metadata_filter_respects_pagination_totals(service):
    await _scan(service)
    page = await service.list_images(metadata="with", page=1, page_size=1)
    assert page["total"] == 2
    assert page["total_pages"] == 2
    assert len(page["items"]) == 1


async def test_listed_items_carry_a_servable_url(service):
    await _scan(service)
    item = (await service.list_images())["items"][0]
    assert item["image_url"].startswith("/api/lm/gallery/image?path=")


# ------------------------------------------------- LoRA hashes / per-LoRA gallery


def _lora_cache_item(file_name, sha256, *, file_path=None, model_name=None):
    return {
        "file_name": file_name,
        "model_name": model_name or file_name,
        "file_path": file_path or f"/models/loras/{file_name}",
        "sha256": sha256,
    }


def test_build_lora_index_resolves_every_prompt_spelling():
    from types import SimpleNamespace

    from py.services.gallery.gallery_indexer import build_lora_index, resolve_lora_hash

    cache = SimpleNamespace(
        raw_data=[
            _lora_cache_item("style_a.safetensors", "a" * 64),
            _lora_cache_item(
                "style_b.safetensors", "b" * 64,
                file_path="/models/loras/sub/style_b.safetensors",
            ),
        ]
    )
    index = build_lora_index(cache)

    assert resolve_lora_hash("style_a.safetensors", index) == "a" * 64
    # "<lora:style_a:0.8>" omits the extension.
    assert resolve_lora_hash("style_a", index) == "a" * 64
    # A prompt may carry the subfolder, or just the basename.
    assert resolve_lora_hash("sub/style_b.safetensors", index) == "b" * 64
    assert resolve_lora_hash("style_b.safetensors", index) == "b" * 64
    assert resolve_lora_hash("not-installed.safetensors", index) is None
    assert resolve_lora_hash("", index) is None


def test_build_lora_index_refuses_an_ambiguous_name():
    """Two different models behind one name must not be guessed at."""
    from types import SimpleNamespace

    from py.services.gallery.gallery_indexer import build_lora_index, resolve_lora_hash

    cache = SimpleNamespace(
        raw_data=[
            _lora_cache_item("dup.safetensors", "a" * 64, file_path="/models/set1/dup.safetensors"),
            _lora_cache_item("dup.safetensors", "b" * 64, file_path="/models/set2/dup.safetensors"),
        ]
    )
    index = build_lora_index(cache)
    assert index["dup.safetensors"] is None
    assert resolve_lora_hash("dup.safetensors", index) is None


def test_build_lora_index_survives_a_cold_or_missing_cache():
    from types import SimpleNamespace

    from py.services.gallery.gallery_indexer import build_lora_index, resolve_lora, resolve_lora_hash

    assert build_lora_index(None) == {}
    assert build_lora_index(SimpleNamespace(raw_data=None)) == {}
    assert resolve_lora_hash("anything", {}) is None

    # Junk entries are skipped, but a real entry whose hash the scanner has not
    # computed yet is still an installed model.
    pending = build_lora_index(SimpleNamespace(raw_data=[{"file_name": "x"}, "junk"]))
    assert resolve_lora("x", pending) == (True, None)
    assert resolve_lora_hash("x", pending) is None


def test_build_lora_index_ignores_version_and_decoration_drift():
    from types import SimpleNamespace

    from py.services.gallery.gallery_indexer import build_lora_index, resolve_lora

    cache = SimpleNamespace(
        raw_data=[
            _lora_cache_item("[Av1] Girls Frontline 2 Gallery v1.0.safetensors", "g" * 64),
        ]
    )
    index = build_lora_index(cache)
    expected = (True, "g" * 64)

    assert resolve_lora("[Av1] Girls Frontline 2 Gallery v1.0", index) == expected
    # No decoration, no version marker, different separators.
    assert resolve_lora("Girls Frontline 2 Gallery", index) == expected
    assert resolve_lora("girls_frontline_2_gallery_v10", index) == expected
    # Word order does not matter either.
    assert resolve_lora("Gallery Girls Frontline 2 v1.0", index) == expected
    assert resolve_lora("Something Else Entirely", index) == (False, None)


def test_build_lora_index_matches_a_shorter_prompt_spelling():
    from types import SimpleNamespace

    from py.services.gallery.gallery_indexer import build_lora_index, resolve_lora

    cache = SimpleNamespace(
        raw_data=[_lora_cache_item("Some Style Concept Art Anima v1.safetensors", "s" * 64)]
    )
    index = build_lora_index(cache)

    # The prompt drops the trailing words; the library file has them.
    assert resolve_lora("Some Style Concept Art", index) == (True, "s" * 64)


def test_build_lora_index_never_guesses_between_two_close_matches():
    from types import SimpleNamespace

    from py.services.gallery.gallery_indexer import build_lora_index, resolve_lora

    cache = SimpleNamespace(
        raw_data=[
            _lora_cache_item("Girls Frontline 2 Gallery A.safetensors", "a" * 64),
            _lora_cache_item("Girls Frontline 2 Gallery B.safetensors", "b" * 64),
        ]
    )
    index = build_lora_index(cache)

    # The shared words are not enough to pick one of the two.
    assert resolve_lora("Girls Frontline 2 Gallery", index) == (False, None)


async def test_scan_records_the_resolved_lora_hash(service, monkeypatch):
    async def _index(self):
        return {"style_a.safetensors": "a" * 64, "style_a": "a" * 64}

    monkeypatch.setattr(GalleryService, "_collect_known_loras", _index)
    await _scan(service)

    items = _by_name((await service.list_images())["items"])
    loras = {entry["name"]: entry for entry in items["comfy_00001_.png"]["loras"]}
    assert loras["style_a.safetensors"]["hash"] == "a" * 64
    assert loras["style_a.safetensors"]["exists_locally"] is True
    # Not in the library: no hash, so the UI must not offer a link.
    assert loras["style_b.safetensors"]["hash"] is None
    assert loras["style_b.safetensors"]["exists_locally"] is False


async def test_images_for_lora_works_by_hash_and_by_name(service, monkeypatch):
    async def _index(self):
        return {"style_a.safetensors": "a" * 64, "style_a": "a" * 64}

    monkeypatch.setattr(GalleryService, "_collect_known_loras", _index)
    await _scan(service)

    by_hash = await service.list_images_for_lora(lora_hash="a" * 64)
    assert [i["file_name"] for i in by_hash["items"]] == ["comfy_00001_.png"]
    assert by_hash["total"] == 1
    assert by_hash["lora"]["hash"] == "a" * 64

    # The name fallback covers a LoRA the library does not know about.
    by_name = await service.list_images_for_lora(lora_name="style_b.safetensors")
    assert [i["file_name"] for i in by_name["items"]] == ["comfy_00001_.png"]

    # Neither key must not mean "everything".
    assert (await service.list_images_for_lora())["total"] == 0
    assert (await service.list_images_for_lora(lora_hash="f" * 64))["total"] == 0


async def test_images_for_lora_carries_a_rating_summary(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 1)

    page = await service.list_images_for_lora(lora_name="style_a.safetensors")
    assert page["summary"] == {
        "total": 1,
        "liked": 1,
        "disliked": 0,
        "unrated": 0,
        "net": 1,
        "loved": 0,
        "hated": 0,
        "score": 1,
        "levels": {"love": 0, "like": 1, "dislike": 0, "hate": 0},
    }
    assert page["items"][0]["image_url"].startswith("/api/lm/gallery/image?path=")


async def test_lora_summary_counts_every_level(tmp_path):
    """The LoRA modal's bar needs one count per level, not just the two sides."""
    service = _seed_lora_ratings(tmp_path, [3, 1, -1, -3])
    page = await service.list_images_for_lora(lora_name="style_x.safetensors")
    assert page["summary"] == {
        "total": 4,
        "liked": 2,
        "disliked": 2,
        "unrated": 0,
        "net": 0,
        "loved": 1,
        "hated": 1,
        "score": 0,
        "levels": {"love": 1, "like": 1, "dislike": 1, "hate": 1},
    }
    assert page["total"] == 4


async def test_images_for_lora_lists_liked_images_first(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 1)
    page = await service.list_images_for_lora(lora_name="style_a.safetensors")
    assert page["items"][0]["rating"] == 1


async def test_images_for_lora_paginates(service):
    await _scan(service)
    page = await service.list_images_for_lora(lora_name="style_a.safetensors", page=2, page_size=1)
    assert page["total"] == 1
    assert page["total_pages"] == 1
    assert page["items"] == []


async def test_reverse_order_walks_the_listing_from_the_other_end(service):
    await _scan(service)

    forward = await service.list_images(sort="name")
    backward = await service.list_images(sort="name", order="asc")

    forward_names = [item["file_name"] for item in forward["items"]]
    backward_names = [item["file_name"] for item in backward["items"]]
    assert forward_names
    assert backward_names == list(reversed(forward_names))


async def test_statistics_can_be_reversed(service):
    await _scan(service)

    forward = await service.stats(by="artist", sort="total")
    reversed_ranking = await service.stats(by="artist", sort="total", order="asc")

    forward_keys = [row["key"] for row in forward["items"]]
    assert forward_keys
    assert [row["key"] for row in reversed_ranking["items"]] == list(reversed(forward_keys))


async def test_statistics_rows_carry_preview_images(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 1)
    await service.set_rating(items["a1111_00002_.png"]["image_path"], -1)

    stats = await service.stats(by="artist")
    rows = {row["key"]: row for row in stats["items"]}

    preview = rows["nnn yryr"]["images"]
    assert len(preview) == 1
    assert preview[0]["image_url"].startswith("/api/lm/gallery/image?path=")
    assert preview[0]["rating"] == 1
    assert rows["heripantomorrow"]["images"][0]["rating"] == -1


async def test_statistics_previews_are_capped_and_carry_urls(service):
    await _scan(service)
    stats = await service.stats(by="lora")
    assert stats["items"], "the fixture indexes images that use LoRAs"
    for row in stats["items"]:
        assert 0 < len(row["images"]) <= 3
        for image in row["images"]:
            assert image["image_url"].startswith("/api/lm/gallery/image?path=")
            assert image["image_path"]


def test_build_lora_index_matches_names_that_differ_only_in_spelling():
    """A name copied from a prompt rarely matches the file name byte for byte."""
    from types import SimpleNamespace

    from py.services.gallery.gallery_indexer import build_lora_index, resolve_lora_hash

    cache = SimpleNamespace(
        raw_data=[
            _lora_cache_item(
                "[Marvel Comics (Capcom)] Marvel vs. Capcom 2 (2009) Concept Art Style Anima.safetensors",
                "m" * 64,
            ),
        ]
    )
    index = build_lora_index(cache)
    expected = "m" * 64

    # Same string, with and without the extension.
    assert resolve_lora_hash(
        "[Marvel Comics (Capcom)] Marvel vs. Capcom 2 (2009) Concept Art Style Anima", index
    ) == expected
    # The bracket decoration is present on one side only.
    assert resolve_lora_hash("Marvel vs. Capcom 2 (2009) Concept Art Style Anima", index) == expected
    # Underscores / case / punctuation drift.
    assert resolve_lora_hash(
        "MARVEL_VS_CAPCOM_2_2009_CONCEPT_ART_STYLE_ANIMA", index
    ) == expected
    assert resolve_lora_hash("something else entirely", index) is None


async def test_newly_installed_lora_is_matched_without_a_rescan(service, monkeypatch):
    async def _scan_index(self):
        # The library did not know the LoRA when the gallery was scanned.
        return {}

    monkeypatch.setattr(GalleryService, "_collect_known_loras", _scan_index)
    await _scan(service)

    items = _by_name((await service.list_images())["items"])
    before = {entry["name"]: entry for entry in items["comfy_00001_.png"]["loras"]}
    assert before["style_a.safetensors"]["exists_locally"] is False
    assert before["style_a.safetensors"]["hash"] is None

    async def _current_library(self):
        return {"style_a.safetensors": "a" * 64}

    monkeypatch.setattr(GalleryService, "_lora_index", _current_library)

    # Same database rows, no rescan: the chip resolves because the read path
    # asks the current library.
    items = _by_name((await service.list_images())["items"])
    after = {entry["name"]: entry for entry in items["comfy_00001_.png"]["loras"]}
    assert after["style_a.safetensors"]["exists_locally"] is True
    assert after["style_a.safetensors"]["hash"] == "a" * 64
    # A LoRA that is still missing stays missing.
    assert after["style_b.safetensors"]["exists_locally"] is False


async def test_statistics_reresolve_a_lora_installed_after_the_scan(service, monkeypatch):
    async def _scan_index(self):
        return {}

    monkeypatch.setattr(GalleryService, "_collect_known_loras", _scan_index)
    await _scan(service)

    async def _current_library(self):
        return {"style_a.safetensors": "a" * 64}

    async def _previews(self):
        return {"a" * 64: "/api/lm/previews?path=root1%2Fpreview%2Fstyle_a.png"}

    monkeypatch.setattr(GalleryService, "_lora_index", _current_library)
    monkeypatch.setattr(GalleryService, "_lora_preview_map", _previews)

    stats = await service.stats(by="lora")
    rows = {row["key"]: row for row in stats["items"]}
    assert rows["style_a.safetensors"]["hash"] == "a" * 64
    assert rows["style_a.safetensors"]["known"] is True
    assert rows["style_a.safetensors"]["preview_url"].startswith("/api/lm/previews")


def test_lora_preview_index_maps_hashes_to_static_urls():
    from types import SimpleNamespace

    from py.services.gallery.lora_previews import build_lora_preview_index

    cache = SimpleNamespace(
        raw_data=[
            {"sha256": "a" * 64, "preview_url": "root1/preview/style_a.png"},
            # No preview, no hash, and junk entries are all skipped.
            {"sha256": "b" * 64, "preview_url": ""},
            {"sha256": "", "preview_url": "root1/preview/orphan.png"},
            "junk",
        ]
    )
    index = build_lora_preview_index(cache)
    assert list(index) == ["a" * 64]
    assert index["a" * 64].startswith("/api/lm/previews?path=")
    assert build_lora_preview_index(None) == {}
    assert build_lora_preview_index(SimpleNamespace(raw_data=None)) == {}


async def test_lora_statistics_rows_carry_the_model_preview(service, monkeypatch):
    async def _index(self):
        return {"style_a.safetensors": "a" * 64, "style_a": "a" * 64}

    monkeypatch.setattr(GalleryService, "_collect_known_loras", _index)
    await _scan(service)

    async def _previews(self):
        return {"a" * 64: "/api/lm/previews?path=root1%2Fpreview%2Fstyle_a.png"}

    monkeypatch.setattr(GalleryService, "_lora_preview_map", _previews)

    stats = await service.stats(by="lora")
    rows = {row["key"]: row for row in stats["items"]}
    assert rows["style_a.safetensors"]["preview_url"].startswith("/api/lm/previews")
    # A LoRA whose hash never resolved has nothing to show, so the UI keeps the
    # gallery image it already had.
    assert rows["style_b.safetensors"]["preview_url"] == ""

    # The artist ranking is about people: animadex supplies those thumbnails,
    # so the stats payload must not pretend to have a model preview.
    artist_stats = await service.stats(by="artist")
    assert all("preview_url" not in row for row in artist_stats["items"])


async def test_statistics_report_the_full_ranking_and_page_through_it(service):
    await _scan(service)

    full = await service.stats(by="artist", sort="total")
    ranked = [row["key"] for row in full["items"]]
    assert len(ranked) >= 2, "the fixture indexes several artists"
    # ``total`` is the ranking size, so the UI can build a pager for it.
    assert full["total"] == len(ranked)
    assert full["offset"] == 0

    first = await service.stats(by="artist", sort="total", limit=1, offset=0)
    assert [row["key"] for row in first["items"]] == [ranked[0]]
    assert first["total"] == len(ranked)

    second = await service.stats(by="artist", sort="total", limit=1, offset=1)
    assert [row["key"] for row in second["items"]] == [ranked[1]]

    # Past the end the page is simply empty; the ranking size is still known.
    beyond = await service.stats(by="artist", sort="total", limit=5, offset=len(ranked))
    assert beyond["items"] == []
    assert beyond["total"] == len(ranked)


async def test_statistics_pages_keep_the_same_order(service):
    await _scan(service)
    paged = []
    for offset in range(3):
        page = await service.stats(by="artist", sort="total", limit=1, offset=offset)
        paged.extend(row["key"] for row in page["items"])
    full = await service.stats(by="artist", sort="total")
    assert paged == [row["key"] for row in full["items"]][:3]


# -------------------------------------------------------------- containment


def test_containment_accepts_inside_and_rejects_outside(tmp_path):
    root = str(tmp_path / "output")
    inside = os.path.join(root, "nested", "a.png")
    assert _is_within_root(inside, root) is True
    assert _is_within_root(str(tmp_path / "elsewhere" / "a.png"), root) is False
    assert _is_within_root("", root) is False
    assert _is_within_root(inside, "") is False


async def test_servable_image_refuses_paths_outside_the_output_directory(service, output_dir):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    inside = items["comfy_00001_.png"]["image_path"]
    assert service.resolve_servable_image(inside) == os.path.abspath(inside)

    assert service.resolve_servable_image(os.path.join(output_dir, "..", "..", "evil.png")) is None
    assert service.resolve_servable_image("") is None


async def test_servable_image_refuses_non_image_extensions(service, output_dir):
    await _scan(service)
    secret = os.path.join(output_dir, "notes.txt")
    with open(secret, "w", encoding="utf-8") as handle:
        handle.write("secret")
    assert service.resolve_servable_image(secret) is None


# ------------------------------------------------------------- output dir


def test_resolve_output_dir_prefers_the_setting(tmp_path):
    settings = get_settings_manager()
    settings.set("gallery_output_path", str(tmp_path))
    path, source = resolve_output_dir(settings)
    assert source == "setting"
    assert path == os.path.abspath(str(tmp_path))


def test_resolve_output_dir_is_unset_without_a_setting_or_comfyui():
    settings = get_settings_manager()
    settings.set("gallery_output_path", "")
    path, source = resolve_output_dir(settings)
    # The test host mocks folder_paths without get_output_directory().
    assert source in {"unset", "comfyui"}
    if source == "unset":
        assert path == ""


def test_iter_image_paths_honours_recursion(output_dir):
    recursive = list(iter_image_paths(output_dir, recursive=True))
    assert len(recursive) == 3
    flat = list(iter_image_paths(output_dir, recursive=False))
    assert len(flat) == 2
    assert list(iter_image_paths(str(os.path.join(output_dir, "missing")))) == []


def test_detect_parser_names_the_metadata_flavour():
    assert detect_parser({"prompt": "{}", "workflow": None, "parameters": None, "comment": None}) == "comfy"
    assert detect_parser({"prompt": None, "workflow": '{"nodes":[]}'}) == "comfy_workflow"
    assert detect_parser({"prompt": None, "workflow": None, "parameters": "Steps: 20"}) == "automatic"
    assert detect_parser({"prompt": None, "workflow": None, "parameters": None, "comment": None}) == "unknown"
