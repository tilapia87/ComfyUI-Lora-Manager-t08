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


@pytest.mark.parametrize("rating", [1, -1, 0])
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
    assert artist_stats["totals"] == {"images": 3, "liked": 1, "disliked": 1, "rated": 2}
    rows = {row["key"]: row for row in artist_stats["items"]}
    assert rows["nnn yryr"]["likes"] == 1 and rows["nnn yryr"]["net"] == 1
    assert rows["nnn yryr"]["like_ratio"] == 1.0 and rows["nnn yryr"]["known"] is True
    assert rows["heripantomorrow"]["dislikes"] == 1 and rows["heripantomorrow"]["net"] == -1
    assert rows["heripantomorrow"]["like_ratio"] == 0.0

    lora_stats = await service.stats(by="lora")
    lora_rows = {row["key"]: row for row in lora_stats["items"]}
    assert set(lora_rows) == {"style_a.safetensors", "style_b.safetensors"}

    # Default sort is net score, descending.
    assert [row["key"] for row in artist_stats["items"]][0] == "nnn yryr"

    # An unrated artist reports no ratio rather than a fake 0.
    await service.set_rating(items["a1111_00002_.png"]["image_path"], 0)
    unrated = await service.stats(by="artist", sort="net")
    rows = {row["key"]: row for row in unrated["items"]}
    assert rows["heripantomorrow"]["like_ratio"] is None
    assert rows["heripantomorrow"]["unrated"] == 1


async def test_statistics_min_total_filters_singletons(service):
    await _scan(service)
    assert (await service.stats(by="artist", min_total=2))["items"] == []


async def test_statistics_sort_options(service):
    await _scan(service)
    items = _by_name((await service.list_images())["items"])
    await service.set_rating(items["comfy_00001_.png"]["image_path"], 1)
    await service.set_rating(items["a1111_00002_.png"]["image_path"], -1)
    for sort in ("net", "likes", "dislikes", "total", "ratio"):
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
