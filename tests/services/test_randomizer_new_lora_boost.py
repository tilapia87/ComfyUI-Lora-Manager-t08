"""Tests for the "new LoRA boost" weighted sampling in LoraService."""

import random
import time
from unittest.mock import AsyncMock, Mock

import pytest

from py.services.lora_service import LoraService

NOW = 1_800_000_000.0
DAY = 86400.0


def build_lora(name: str, modified: float) -> dict:
    return {
        "file_name": f"{name}.safetensors",
        "folder": "",
        "name": f"{name}.safetensors",
        "modified": modified,
    }


@pytest.fixture
def scanner_with_loras():
    def _factory(loras):
        scanner = Mock()
        cache_mock = Mock()
        cache_mock.raw_data = loras
        scanner.get_cached_data = AsyncMock(return_value=cache_mock)
        scanner._hash_index = Mock()
        scanner._hash_index.get_duplicate_hashes = Mock(return_value={})
        scanner._hash_index.get_duplicate_filenames = Mock(return_value={})
        return scanner

    return _factory


def test_build_new_lora_weights_decays_linearly():
    service = LoraService(Mock())
    loras = [
        build_lora("brand_new", NOW),
        build_lora("half_window", NOW - 3.5 * DAY),
        build_lora("at_edge", NOW - 7 * DAY),
        build_lora("ancient", NOW - 400 * DAY),
    ]

    weights = service._build_new_lora_weights(
        loras, boost_strength=5.0, boost_days=7.0, now=NOW
    )

    assert weights[0] == pytest.approx(5.0)
    assert weights[1] == pytest.approx(3.0)  # halfway through the window
    assert weights[2] == pytest.approx(1.0)  # window edge
    assert weights[3] == pytest.approx(1.0)


def test_build_new_lora_weights_treats_missing_modified_as_old():
    service = LoraService(Mock())
    loras = [
        {"file_name": "unknown.safetensors", "folder": ""},
        {"file_name": "broken.safetensors", "folder": "", "modified": "not-a-number"},
        build_lora("fresh", NOW),
    ]

    weights = service._build_new_lora_weights(
        loras, boost_strength=4.0, boost_days=7.0, now=NOW
    )

    assert weights[0] == pytest.approx(1.0)
    assert weights[1] == pytest.approx(1.0)
    assert weights[2] == pytest.approx(4.0)


def test_build_new_lora_weights_disabled_when_strength_is_one():
    service = LoraService(Mock())
    loras = [build_lora("fresh", NOW), build_lora("ancient", NOW - 400 * DAY)]

    weights = service._build_new_lora_weights(
        loras, boost_strength=1.0, boost_days=7.0, now=NOW
    )

    assert weights == [1.0, 1.0]


def test_weighted_sample_returns_unique_items():
    service = LoraService(Mock())
    items = [build_lora(f"lora_{i}", NOW) for i in range(20)]
    weights = [1.0 + i for i in range(20)]
    rng = random.Random(7)

    selected = service._weighted_sample_without_replacement(items, weights, 8, rng)

    assert len(selected) == 8
    assert len({item["file_name"] for item in selected}) == 8


def test_weighted_sample_returns_everything_when_count_exceeds_pool():
    service = LoraService(Mock())
    items = [build_lora("a", NOW), build_lora("b", NOW)]
    rng = random.Random(1)

    selected = service._weighted_sample_without_replacement(
        items, [10.0, 1.0], 5, rng
    )

    assert selected == items


async def test_get_random_loras_boost_biases_towards_new_lora(scanner_with_loras):
    """A heavily boosted new LoRA should be picked far more often than an old one."""
    real_now = time.time()
    old_loras = [build_lora(f"old_{i}", real_now - 200 * DAY) for i in range(9)]
    new_lora = build_lora("new", real_now)
    service = LoraService(scanner_with_loras(old_loras + [new_lora]))

    hits = 0
    trials = 300
    for seed in range(trials):
        selected = await service.get_random_loras(
            count=1,
            use_new_lora_boost=True,
            new_lora_boost_strength=10.0,
            new_lora_boost_days=7.0,
            seed=seed,
        )
        if selected[0]["name"] == "new.safetensors":
            hits += 1

    # Without a boost the expected rate would be 1/10 = 10% (~30 hits).
    # With a 10x weight the expected rate is 10/19 = ~53% (~158 hits).
    assert hits > 90


async def test_get_random_loras_without_boost_matches_uniform_sampling(
    scanner_with_loras,
):
    real_now = time.time()
    old_loras = [build_lora(f"old_{i}", real_now - 200 * DAY) for i in range(9)]
    new_lora = build_lora("new", real_now)
    service = LoraService(scanner_with_loras(old_loras + [new_lora]))

    picked = set()
    for seed in range(5):
        selected = await service.get_random_loras(count=10, seed=seed)
        picked.update(lora["name"] for lora in selected)

    assert len(picked) == 10


async def test_get_random_loras_respects_slot_count_with_boost(scanner_with_loras):
    loras = [build_lora(f"lora_{i}", NOW - i * DAY) for i in range(12)]
    service = LoraService(scanner_with_loras(loras))

    selected = await service.get_random_loras(
        count=4,
        use_new_lora_boost=True,
        new_lora_boost_strength=5.0,
        new_lora_boost_days=7.0,
        seed=42,
    )

    assert len(selected) == 4
    assert len({lora["name"] for lora in selected}) == 4
