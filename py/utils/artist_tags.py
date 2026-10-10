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
"""

from __future__ import annotations

import logging
import os
import re
from typing import Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Comma-separated prompt segments are the unit an artist tag lives in. Weights
# and the model's own parenthesised weighting syntax may wrap the tag, so a
# segment is inspected after stripping one layer of brackets.
_WRAPPER_OPEN_CHARS = "([{"
_WRAPPER_CLOSE_CHARS = ")]}"

# A trailing ``:1.2`` left behind by the model's weighting syntax.
_WEIGHT_SUFFIX_PATTERN = re.compile(r":\s*[+-]?\d*\.?\d+\s*$")

# A sentence boundary inside a mixed tag/natural-language prompt, as shown in the
# model card: "@big chungus. An anime girl with ...". Only a period followed by a
# capital letter starts a new sentence; "k.k. slider" keeps its periods.
_SENTENCE_BREAK_PATTERN = re.compile(r"\.\s+(?=[A-Z])")


def _fold(name: str) -> str:
    """Normalize a name for comparison.

    Anima asks for lowercase with spaces instead of underscores, while danbooru
    exports keep underscores, so folding has to bridge the two spellings.
    """
    return re.sub(r"\s+", " ", name.replace("_", " ")).strip().lower()


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


def _clean_artist_name(raw: str) -> str:
    """Reduce the text after ``@`` to the artist name alone."""
    name = raw.strip()
    if not name:
        # A bare "@" is not an artist.
        return ""

    # Drop the bracket a weighted tag left behind *before* the weight itself:
    # "(@nnn yryr:1.2)" only exposes ":1.2" once the ")" is gone.
    name = name.rstrip("".join(_WRAPPER_CLOSE_CHARS) + r"\ ").strip()
    name = _WEIGHT_SUFFIX_PATTERN.sub("", name).strip()

    # Stop at a sentence boundary so mixed natural-language prompts do not
    # swallow the prose that follows the artist tag.
    name = _SENTENCE_BREAK_PATTERN.split(name, maxsplit=1)[0]

    # A newline always terminates a tag, and a danbooru escape may lead the name.
    name = name.splitlines()[0].strip().lstrip("\\").strip()
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

# ``(path, mtime, size)`` -> index. The number of distinct artist lists a user
# configures is tiny, so a small dict is enough and stale keys fall out of use.
_INDEX_CACHE: Dict[Tuple[str, float, int], ArtistIndex] = {}


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
        mapping.setdefault(_fold(entry), entry)
    return mapping


def load_artist_index(path: str, *, use_cache: bool = True) -> ArtistIndex:
    """Load an artist list, caching it until the file changes.

    A missing or unreadable file yields an empty index rather than an error:
    the list only confirms and canonicalizes names, and extraction must keep
    working when it is unavailable.
    """
    if not path:
        return EMPTY_ARTIST_INDEX

    try:
        stat = os.stat(path)
    except OSError:
        logger.warning("Artist list not found or unreadable: %s", path)
        return EMPTY_ARTIST_INDEX

    key = (os.path.abspath(path), stat.st_mtime, stat.st_size)
    if use_cache:
        cached = _INDEX_CACHE.get(key)
        if cached is not None:
            return cached

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            mapping = _parse_artist_list(handle)
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
        candidate = segment.strip().lstrip("".join(_WRAPPER_OPEN_CHARS)).strip()
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
