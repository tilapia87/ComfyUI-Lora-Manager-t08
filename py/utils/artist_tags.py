"""Artist-tag extraction for the gallery.

The Anima model family documents a dedicated artist syntax: an artist is
referenced by prefixing its name with ``@``, and the name itself keeps its
spaces, e.g. ``@nnn yryr`` or ``@big chungus``. The model card is explicit that
omitting the ``@`` makes the artist effect "very weak", so a prompt that used an
artist always carries the marker. Artist tags sit in their own comma-separated
segment, which makes the positive prompt the authoritative place to read them
from -- the recommended negative prompt literally contains ``artist name`` and
must never be scanned.

An optional artist list (danbooru-style exports such as ``known_artists.txt``)
is used to confirm and canonicalize a name: the export lists ``yaneko uta``,
while a prompt may spell it with different casing. Unknown names are still
recorded, flagged as such, so statistics never silently drop an artist.

Two sources are merged, because neither contains the other:

* the danbooru/e621 CSV shipped in ``refs/`` (84k artists, underscore-form);
* an optional user list (one artist tag per line, typically space-form).

:func:`_fold` bridges the underscore/space split, so ``hammer_(sunset_beach)``
from the CSV matches ``@hammer (sunset beach)`` in an Anima prompt.
"""

from __future__ import annotations

import csv
import logging
import os
import re
from typing import Callable, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# danbooru category 1 and e621 category 8 both mean "artist". Keeping only
# these matters: the CSV also holds general tags like "1girl", and admitting
# those would make the "known artist" flag meaningless.
_DANBOORU_ARTIST_CATEGORIES = frozenset({"1", "8"})

# The tag export shipped with the plugin (see py/services/tag_fts_index.py).
_BUNDLED_ARTIST_CSV = "danbooru_e621_merged.csv"

# Comma-separated prompt segments are the unit an artist tag lives in. Weights
# and the model's own parenthesised weighting syntax may wrap the tag, so a
# segment is inspected after stripping one layer of brackets.
_WRAPPER_OPEN_CHARS = "([{"
_WRAPPER_CLOSE_CHARS = ")]}"

# A trailing ``:1.2`` left behind by the model's weighting syntax.
_WEIGHT_SUFFIX_PATTERN = re.compile(r":\s*[+-]?\d*\.?\d+\s*$")

# Wrapper pairs that may enclose a whole artist tag rather than belong to the
# name. The escaped pair is danbooru's literal-parenthesis notation.
_WRAPPER_PAIRS = (("(", ")"), ("[", "]"), ("{", "}"), ("\\(", "\\)"))

# A sentence boundary inside a mixed tag/natural-language prompt, as shown in the
# model card: "@big chungus. An anime girl with ...". Only a period followed by a
# capital letter starts a new sentence; "k.k. slider" keeps its periods.
_SENTENCE_BREAK_PATTERN = re.compile(r"\.\s+(?=[A-Z])")


def _unescape_parentheses(name: str) -> str:
    """Turn danbooru's escaped parentheses back into literal ones.

    Anima prompts escape every parenthesis -- ``@hammer \\(sunset beach\\)`` --
    so the model reads a literal bracket instead of attention weighting. The
    artist export stores the same name with plain underscores
    (``hammer_(sunset_beach)``), so the escapes have to come off before the two
    can be compared.
    """
    return name.replace("\\(", "(").replace("\\)", ")")


def _fold(name: str) -> str:
    """Normalize a name for comparison.

    Anima asks for lowercase with spaces instead of underscores, while danbooru
    exports keep underscores, so folding has to bridge the two spellings. The
    escapes come off here as well, so a name matches even if some caller forgot
    to unescape it on the way in.
    """
    normalized = _unescape_parentheses(name).replace("_", " ")
    return re.sub(r"\s+", " ", normalized).strip().lower()


def _split_top_level(text: str, separator: str = ",") -> List[str]:
    """Split on *separator* at bracket depth zero.

    Weighted tags such as ``(masterpiece:1.2, detail:1.1)`` contain commas that
    do not separate tags, so a naive ``str.split`` would shred them.
    """
    segments: List[str] = []
    current: List[str] = []
    depth = 0
    for char in text:
        if char in _WRAPPER_OPEN_CHARS:
            depth += 1
        elif char in _WRAPPER_CLOSE_CHARS:
            depth = max(0, depth - 1)
        elif char == separator and depth == 0:
            segments.append("".join(current))
            current = []
            continue
        current.append(char)
    segments.append("".join(current))
    return segments


def _strip_balanced_wrapper(segment: str) -> str:
    """Remove one wrapper that encloses the whole segment.

    A whole artist tag may be wrapped to weight or group it -- ``(@name:1.2)``,
    ``{@name}``, or danbooru's escaped ``\\(@name\\)``. Only a pair enclosing the
    entire segment counts, so a bracket that belongs to the name itself
    (``@hammer (sunset beach)``) is left alone.
    """
    for opener, closer in _WRAPPER_PAIRS:
        if (
            segment.startswith(opener)
            and segment.endswith(closer)
            and len(segment) > len(opener) + len(closer) + 1
        ):
            return segment[len(opener) : -len(closer)].strip()
    return segment


def _clean_artist_name(raw: str) -> str:
    """Reduce the text after ``@`` to the artist name alone."""
    name = raw.strip()
    if not name:
        # A bare "@" is not an artist.
        return ""

    # Drop the weighting suffix the model's "(tag:1.2)" syntax leaves behind.
    # The enclosing bracket is removed by the caller, so a bracket that belongs
    # to the name itself -- "@hammer (sunset beach)" -- survives.
    name = _WEIGHT_SUFFIX_PATTERN.sub("", name).strip()

    # Danbooru escapes literal parentheses and Anima prompts escape every one
    # of them: "@hammer \(sunset beach\)".
    name = _unescape_parentheses(name).strip()

    # Stop at a sentence boundary so mixed natural-language prompts do not
    # swallow the prose that follows the artist tag.
    name = _SENTENCE_BREAK_PATTERN.split(name, maxsplit=1)[0]

    # A newline always terminates a tag.
    name = name.splitlines()[0].strip()
    return name


class ArtistIndex:
    """Artist list used to confirm and canonicalize names found after ``@``."""

    __slots__ = ("_mapping", "source")

    def __init__(self, mapping: Optional[Dict[str, str]] = None, source: str = "") -> None:
        self._mapping = mapping or {}
        self.source = source

    def __len__(self) -> int:
        return len(self._mapping)

    def __bool__(self) -> bool:
        return bool(self._mapping)

    def canonical(self, name: str) -> Optional[str]:
        """Return the artist list's spelling of *name*, or ``None`` if unknown."""
        return self._mapping.get(_fold(name))

    def is_known(self, name: str) -> bool:
        return _fold(name) in self._mapping

    def as_dict(self) -> Dict[str, str]:
        return dict(self._mapping)


EMPTY_ARTIST_INDEX = ArtistIndex()

# ``(path, mtime, size, parser)`` -> index. The number of distinct artist lists
# a user configures is tiny, so a small dict is enough and stale keys fall out of
# use. The parser is part of the key because the same path is never both.
_INDEX_CACHE: Dict[Tuple[str, float, int, str], ArtistIndex] = {}


def _parse_artist_list(lines: Iterable[str]) -> Dict[str, str]:
    """Map folded artist names to their canonical spelling.

    The list is one artist tag per line. Comment lines and blanks are skipped;
    entries that are only digits or punctuation are dropped because they would
    match almost any prompt as an artist.
    """
    mapping: Dict[str, str] = {}
    for line in lines:
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        if not re.search(r"[^\W\d_]", entry, re.UNICODE):
            # No letter at all: ".", "0", "0.05", "00047".
            continue
        # Exports write the disambiguator with danbooru escapes --
        # "addy \(@vegeebs\)". Store the plain form: it is what a user wants to
        # read in a chip, and folding still matches either spelling.
        canonical = _unescape_parentheses(entry)
        mapping.setdefault(_fold(canonical), canonical)
    return mapping


def _parse_danbooru_artist_csv(handle: Iterable[str]) -> Dict[str, str]:
    """Map folded artist names to their canonical spelling from a tag CSV.

    The export is ``name,category,post_count,"aliases"`` with the category in
    the second column. Only artist categories are kept; the file also lists
    general tags such as ``1girl``, and admitting those would make the "known
    artist" flag meaningless. Names are underscore-form here while Anima prompts
    use spaces, which :func:`_fold` bridges.
    """
    mapping: Dict[str, str] = {}
    for row in csv.reader(handle):
        if len(row) < 2:
            continue
        name = row[0].strip()
        if not name or row[1].strip() not in _DANBOORU_ARTIST_CATEGORIES:
            continue
        mapping.setdefault(_fold(name), _unescape_parentheses(name))
    return mapping


def bundled_artist_list_path() -> str:
    """Return the artist CSV shipped with the plugin, or ``""`` when absent."""
    # py/utils/artist_tags.py -> <plugin root>/refs/<csv>
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    path = os.path.join(root, "refs", _BUNDLED_ARTIST_CSV)
    return path if os.path.isfile(path) else ""


def _load_index(
    path: str,
    parser: Callable[[Iterable[str]], Dict[str, str]],
    kind: str,
    *,
    use_cache: bool,
) -> ArtistIndex:
    """Read *path* through *parser*, caching by ``(path, mtime, size, kind)``."""
    if not path:
        return EMPTY_ARTIST_INDEX

    try:
        stat = os.stat(path)
    except OSError:
        logger.warning("Artist list not found or unreadable: %s", path)
        return EMPTY_ARTIST_INDEX

    key = (os.path.abspath(path), stat.st_mtime, stat.st_size, kind)
    if use_cache:
        cached = _INDEX_CACHE.get(key)
        if cached is not None:
            return cached

    try:
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as handle:
            mapping = parser(handle)
    except OSError as exc:
        logger.warning("Could not read artist list %s: %s", path, exc)
        return EMPTY_ARTIST_INDEX

    index = ArtistIndex(mapping, source=os.path.abspath(path))
    if use_cache:
        # Drop entries for the same path that have been superseded.
        for stale in [item for item in _INDEX_CACHE if item[0] == key[0] and item != key]:
            _INDEX_CACHE.pop(stale, None)
        _INDEX_CACHE[key] = index
    logger.info("Loaded %d artists from %s", len(index), path)
    return index


def load_artist_index(path: str, *, use_cache: bool = True) -> ArtistIndex:
    """Load a one-artist-per-line list, caching it until the file changes.

    A missing or unreadable file yields an empty index rather than an error:
    the list only confirms and canonicalizes names, and extraction must keep
    working when it is unavailable.
    """
    return _load_index(path, _parse_artist_list, "text", use_cache=use_cache)


def load_danbooru_artist_index(path: str = "", *, use_cache: bool = True) -> ArtistIndex:
    """Load the shipped danbooru/e621 tag CSV, keeping its artist rows only."""
    return _load_index(
        path or bundled_artist_list_path(),
        _parse_danbooru_artist_csv,
        "danbooru_csv",
        use_cache=use_cache,
    )


def load_gallery_artist_index(
    user_path: str = "",
    *,
    use_bundled: bool = True,
    use_cache: bool = True,
) -> ArtistIndex:
    """Build the index the gallery normalizes against.

    The shipped CSV and a user list are complementary -- the CSV carries artists
    the user's export lacks and vice versa -- so they are merged, with the user
    list winning on the display name because it is the one the user curates.
    """
    merged: Dict[str, str] = {}
    sources: List[str] = []

    if use_bundled:
        bundled = load_danbooru_artist_index(use_cache=use_cache)
        if bundled:
            merged.update(bundled.as_dict())
            sources.append(bundled.source)

    if user_path:
        user = load_artist_index(user_path, use_cache=use_cache)
        if user:
            merged.update(user.as_dict())
            sources.append(user.source)

    if not merged:
        return EMPTY_ARTIST_INDEX
    return ArtistIndex(merged, source=" + ".join(sources))



def clear_artist_index_cache() -> None:
    """Drop the cached artist lists. Used by tests and after a settings change."""
    _INDEX_CACHE.clear()


def extract_artist_names(prompt: str) -> List[str]:
    """Return the artist names a prompt references with ``@``, in order.

    Only ``@``-prefixed segments count. A name may contain spaces, which is the
    documented Anima spelling (``@nnn yryr``).
    """
    if not prompt:
        return []

    names: List[str] = []
    seen: set[str] = set()
    for segment in _split_top_level(prompt):
        candidate = _strip_balanced_wrapper(segment.strip())
        if not candidate.startswith("@"):
            continue
        name = _clean_artist_name(candidate[1:])
        if not name:
            continue
        folded = _fold(name)
        if folded in seen:
            continue
        seen.add(folded)
        names.append(name)
    return names


def extract_artists(
    prompt: str, index: Optional[ArtistIndex] = None
) -> List[Dict[str, object]]:
    """Return ``[{"name", "canonical", "known"}]`` for every artist in *prompt*.

    ``canonical`` is the artist list's spelling when the list knows the name,
    otherwise it repeats ``name``. ``known`` reports whether the list matched, so
    the UI can separate confirmed artists from free-form ones.
    """
    resolved = index or EMPTY_ARTIST_INDEX
    artists: List[Dict[str, object]] = []
    for name in extract_artist_names(prompt):
        canonical = resolved.canonical(name)
        artists.append(
            {
                "name": name,
                "canonical": canonical or name,
                "known": canonical is not None,
            }
        )
    return artists
