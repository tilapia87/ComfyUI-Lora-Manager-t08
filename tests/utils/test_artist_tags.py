"""Tests for @-prefixed artist tag extraction (the Anima artist syntax)."""

from __future__ import annotations

import os

import pytest

from py.utils.artist_tags import (
    ArtistIndex,
    EMPTY_ARTIST_INDEX,
    clear_artist_index_cache,
    extract_artist_names,
    extract_artists,
    load_artist_index,
)


@pytest.fixture(autouse=True)
def _clear_cache():
    clear_artist_index_cache()
    yield
    clear_artist_index_cache()


def _write_list(tmp_path, text: str) -> str:
    path = tmp_path / "artists.txt"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_extracts_multi_word_artist_name():
    # The Anima model card's own example: the artist name keeps its spaces.
    prompt = (
        "year 2025, newest, normal quality, score_5, highres, safe, 1girl, "
        "oomuro sakurako, yuru yuri, @nnn yryr, smile, brown hair, hat, solo"
    )
    assert extract_artist_names(prompt) == ["nnn yryr"]


def test_extracts_every_artist_and_keeps_order():
    prompt = "@alpha artist, 1girl, @beta artist, smile"
    assert extract_artist_names(prompt) == ["alpha artist", "beta artist"]


def test_deduplicates_case_insensitively():
    assert extract_artist_names("@nnn yryr, 1girl, @NNN YRYR") == ["nnn yryr"]


def test_stops_at_a_sentence_boundary():
    prompt = "masterpiece, best quality, @big chungus. An anime girl with blonde hair."
    assert extract_artist_names(prompt) == ["big chungus"]


def test_keeps_periods_inside_an_artist_name():
    # "k.k. slider" must not be truncated at its own periods.
    assert extract_artist_names("1girl, @k.k. slider, smile") == ["k.k. slider"]


@pytest.mark.parametrize(
    "prompt",
    [
        "1girl, (@nnn yryr:1.2), smile",
        "1girl, {@nnn yryr:1.5}, smile",
        "1girl, @nnn yryr, smile",
    ],
)
def test_strips_weighting_syntax(prompt):
    assert extract_artist_names(prompt) == ["nnn yryr"]


def test_ignores_commas_inside_weighted_tags():
    prompt = "(masterpiece:1.2, detail:1.1), @yaneko uta, 1girl"
    assert extract_artist_names(prompt) == ["yaneko uta"]


def test_negative_prompt_yields_no_artists():
    # Anima's recommended negative prompt literally contains "artist name";
    # scanning it would invent a phantom artist.
    assert extract_artist_names("worst quality, low quality, artist name, blurry") == []


def test_names_without_the_at_prefix_are_not_artists():
    assert extract_artist_names("1girl, yaneko uta, masterpiece") == []


@pytest.mark.parametrize("prompt", ["", "@", "1girl, @, smile", "no artists here"])
def test_degenerate_input_is_safe(prompt):
    assert extract_artist_names(prompt) == []


def test_artist_index_confirms_and_canonicalizes(tmp_path):
    path = _write_list(tmp_path, "yaneko uta\nheripantomorrow\n# a comment\n\n")
    index = load_artist_index(path)
    assert len(index) == 2

    artists = extract_artists("1girl, @YANEKO UTA, solo", index)
    assert artists == [{"name": "YANEKO UTA", "canonical": "yaneko uta", "known": True}]


def test_underscore_and_space_spellings_are_equivalent(tmp_path):
    # Danbooru exports keep underscores; Anima prompts use spaces.
    path = _write_list(tmp_path, "yaneko uta\n")
    index = load_artist_index(path)
    assert index.is_known("yaneko_uta")
    assert extract_artists("1girl, @yaneko_uta", index)[0]["known"] is True


def test_unknown_artist_is_kept_and_flagged(tmp_path):
    path = _write_list(tmp_path, "yaneko uta\n")
    index = load_artist_index(path)
    assert extract_artists("1girl, @nobody here", index) == [
        {"name": "nobody here", "canonical": "nobody here", "known": False}
    ]


def test_artist_list_skips_entries_without_letters(tmp_path):
    # Real exports contain ".", "0", "0.05", "#13" which would match anything.
    path = _write_list(tmp_path, ".\n0\n0.05\n#13\nreal artist\n")
    index = load_artist_index(path)
    assert len(index) == 1
    assert index.is_known("real artist")


def test_missing_artist_list_is_not_an_error(tmp_path):
    index = load_artist_index(str(tmp_path / "does-not-exist.txt"))
    assert len(index) == 0
    assert not index
    assert extract_artists("1girl, @someone", index)[0]["name"] == "someone"


def test_empty_path_returns_the_shared_empty_index():
    assert load_artist_index("") is EMPTY_ARTIST_INDEX


def test_index_cache_is_reused_then_invalidated(tmp_path):
    path = _write_list(tmp_path, "first artist\n")
    first = load_artist_index(path)
    assert len(first) == 1
    assert load_artist_index(path) is first

    # A rewrite changes size and mtime, so a fresh index must be read.
    _write_list(tmp_path, "first artist\nsecond artist\n")
    os.utime(path, (0, 0))
    reloaded = load_artist_index(path)
    assert len(reloaded) == 2
    assert reloaded is not first


def test_artist_index_can_be_built_directly():
    index = ArtistIndex({"foo": "foo bar"}, source="memory")
    assert index.canonical("FOO") == "foo bar"
    assert index.as_dict() == {"foo": "foo bar"}
