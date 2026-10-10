"""Tests for @-prefixed artist tag extraction (the Anima artist syntax)."""

from __future__ import annotations

import os

import pytest

from py.utils.artist_tags import (
    ArtistIndex,
    EMPTY_ARTIST_INDEX,
    bundled_artist_list_path,
    clear_artist_index_cache,
    extract_artist_names,
    extract_artists,
    load_artist_index,
    load_danbooru_artist_index,
    load_gallery_artist_index,
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


# --- the danbooru/e621 CSV shipped in refs/, and the merged gallery index ----


def _write_csv(tmp_path, text: str) -> str:
    path = tmp_path / "artists.csv"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_danbooru_csv_keeps_only_artist_categories(tmp_path):
    # category 1 = danbooru artist, 8 = e621 artist; everything else is not one.
    path = _write_csv(
        tmp_path,
        '1girl,0,6008644,"1girls,sole_female"\n'
        "ebifurya,1,2000,\n"
        "hammer_(sunset_beach),1,1500,\n"
        "some_character,4,900,\n"
        "some_artist,8,800,alias\n"
        "highres,5,5256194,\n",
    )
    index = load_danbooru_artist_index(path)
    assert len(index) == 3
    assert index.is_known("ebifurya")
    assert index.is_known("which is this") is False
    # A general tag and a character tag must not become "known artists".
    assert not index.is_known("1girl")
    assert not index.is_known("some character")


def test_danbooru_csv_underscores_match_anima_space_spelling(tmp_path):
    # The CSV stores "hammer_(sunset_beach)"; an Anima prompt writes
    # "@hammer (sunset beach)". Folding has to bridge the two.
    path = _write_csv(tmp_path, "hammer_(sunset_beach),1,1500,\n")
    index = load_danbooru_artist_index(path)
    artists = extract_artists("1girl, @hammer (sunset beach), smile", index)
    assert artists == [
        {
            "name": "hammer (sunset beach)",
            "canonical": "hammer_(sunset_beach)",
            "known": True,
        }
    ]


def test_bundled_artist_csv_ships_with_the_plugin():
    path = bundled_artist_list_path()
    assert path, "refs/danbooru_e621_merged.csv should exist in the checkout"
    assert os.path.isfile(path)

    index = load_danbooru_artist_index(path)
    # The shipped export has ~84k artist rows; guard against a silent mis-parse.
    assert len(index) > 80_000
    assert index.is_known("ebifurya")


def test_gallery_index_merges_the_bundled_csv_with_a_user_list(tmp_path, monkeypatch):
    # "csv_only_artist" exists only in the shipped export, "user_only_artist"
    # only in the user's list; the merged index must know both.
    import py.utils.artist_tags as artist_tags

    csv_path = _write_csv(tmp_path, "csv_only_artist,1,10,\nshared_name,1,10,\n")
    user_path = tmp_path / "mine.txt"
    user_path.write_text("user_only_artist\nshared name\n", encoding="utf-8")
    monkeypatch.setattr(artist_tags, "bundled_artist_list_path", lambda: csv_path)

    index = load_gallery_artist_index(str(user_path), use_cache=False)
    assert index.is_known("csv only artist")
    assert index.is_known("user only artist")
    # The user's spelling wins for a name both files contain.
    assert index.canonical("shared_name") == "shared name"
    # A CSV-only name keeps the shipped spelling.
    assert index.canonical("csv_only_artist") == "csv_only_artist"


def test_gallery_index_uses_the_shipped_csv_when_no_user_list_is_set():
    index = load_gallery_artist_index("")
    assert len(index) > 80_000
    assert index.is_known("ebifurya")


def test_gallery_index_without_the_bundled_csv_and_no_user_list_is_empty(tmp_path, monkeypatch):
    import py.utils.artist_tags as artist_tags

    monkeypatch.setattr(artist_tags, "bundled_artist_list_path", lambda: "")
    assert load_gallery_artist_index("") is EMPTY_ARTIST_INDEX


def test_gallery_index_falls_back_when_the_user_list_is_missing(tmp_path):
    # A bad path must not take the shipped list down with it.
    index = load_gallery_artist_index(str(tmp_path / "nope.txt"))
    assert len(index) > 80_000


# --- escaped parentheses: Anima escapes every bracket in a prompt -----------


def test_escaped_parentheses_become_literal_ones():
    # Anima prompts write "@hammer \(sunset beach\)" so the model reads a literal
    # bracket instead of attention weighting.
    assert extract_artist_names(r"1girl, @hammer \(sunset beach\), smile") == [
        "hammer (sunset beach)"
    ]


def test_escaped_name_matches_the_underscore_export(tmp_path):
    path = _write_csv(tmp_path, "hammer_(sunset_beach),1,1500,\n")
    index = load_danbooru_artist_index(path)
    artists = extract_artists(r"1girl, @hammer \(sunset beach\), smile", index)
    assert artists == [
        {
            "name": "hammer (sunset beach)",
            "canonical": "hammer_(sunset_beach)",
            "known": True,
        }
    ]


def test_colon_inside_escaped_parentheses_is_not_eaten_as_a_weight():
    # The weight stripper must not treat "(...: star rail)" as ":weight".
    assert extract_artist_names(r"1girl, @firefly \(honkai: star rail\), smile") == [
        "firefly (honkai: star rail)"
    ]


def test_escaped_weighted_wrapper_is_stripped():
    # "\(@name:1.2\)" is a weighted group around the whole tag.
    assert extract_artist_names(r"1girl, \(@nnn yryr:1.2\), smile") == ["nnn yryr"]


def test_multiple_escaped_artists_in_one_prompt():
    prompt = r"masterpiece, 1girl, @alpha \(series a\), solo, @beta \(series b\), smile"
    assert extract_artist_names(prompt) == ["alpha (series a)", "beta (series b)"]


def test_realistic_anima_prompt_with_escapes(tmp_path):
    # Mirrors the model card's own example shape: tag order with escaped
    # brackets on the character, the series and the artist.
    path = _write_csv(tmp_path, "hoshimachi_suisei_(1st_costume),1,10,\n")
    index = load_danbooru_artist_index(path)
    prompt = (
        "masterpiece, best quality, safe, 1girl, hoshimachi suisei, "
        r"hoshimachi suisei \(1st costume\), @hoshimachi suisei \(1st costume\), cosplay, smile"
    )
    assert extract_artists(prompt, index)[0]["canonical"] == "hoshimachi_suisei_(1st_costume)"


def test_folding_bridges_escapes_without_an_explicit_unescape(tmp_path):
    # Defence in depth: even a name that still carries escapes has to match the
    # export, because that is the only form Anima ever writes.
    path = _write_csv(tmp_path, "k_k_slider,1,10,\n")
    index = load_danbooru_artist_index(path)
    assert index.is_known(r"k k slider \(ver 2\)") is False  # sanity: folds, no match
    assert index.is_known("k_k_slider") is True
    # The escaped form of a name that IS in the export must match too.
    index2 = load_danbooru_artist_index(_write_csv(tmp_path, "hammer_(sunset_beach),1,10,\n"))
    assert index2.canonical(r"hammer \(sunset beach\)") == "hammer_(sunset_beach)"


def test_canonical_names_never_keep_danbooru_escapes(tmp_path):
    # A real export writes every disambiguator escaped -- "addy \(@vegeebs\)".
    # A chip must show the plain name, not the backslashes.
    path = _write_list(
        tmp_path, "+1 \\(yakusoku0722\\)\naddy \\(@vegeebs\\)\n"
    )
    index = load_artist_index(path)
    assert index.canonical("+1 (yakusoku0722)") == "+1 (yakusoku0722)"
    assert index.canonical("addy (@vegeebs)") == "addy (@vegeebs)"
    assert all("\\" not in value for value in index.as_dict().values())


def test_extraction_and_export_meet_at_the_plain_name():
    # The two spellings that actually occur -- Anima's escaped prompt and the
    # export's escaped list entry -- must land on the same artist. The index key
    # is already folded, so the plain name is what it holds.
    index = ArtistIndex({"addy (@vegeebs)": "addy (@vegeebs)"}, source="memory")
    artists = extract_artists(r"1girl, @addy \(@vegeebs\), smile", index)
    assert artists == [
        {"name": "addy (@vegeebs)", "canonical": "addy (@vegeebs)", "known": True}
    ]
