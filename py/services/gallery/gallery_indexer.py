"""Walk the ComfyUI output directory and extract what each image was made with.

The gallery deliberately reuses the recipe pipeline's metadata readers instead of
growing a second implementation: ``ExifUtils`` knows how to pull the embedded
chunks out of every container ComfyUI writes, and
``extract_generation_metadata`` already follows a ComfyUI graph through the
sampler's real links (including LoRA loader chains) while also understanding
A1111 ``parameters`` text. On top of that we only add the one thing the recipe
pipeline has no concept of: ``@``-prefixed artist tags.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, Iterator, List, Optional, Sequence, Set, Tuple

from ...utils.artist_tags import ArtistIndex, EMPTY_ARTIST_INDEX, extract_artists
from ...utils.exif_utils import ExifUtils
from ...utils.generation_metadata import MetadataError, extract_generation_metadata

logger = logging.getLogger(__name__)

# Containers ComfyUI can save and whose metadata we know how to read. Kept local
# rather than importing another module's private constant.
GALLERY_IMAGE_EXTENSIONS = frozenset(
    {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"}
)

# A safety valve against pointing the gallery at a whole drive by accident.
MAX_IMAGES_PER_SCAN = 200_000

# Genuine generation settings, kept out of the prompt columns.
_PROMPT_KEYS = ("positive", "negative")


def resolve_output_dir(settings: Any) -> Tuple[str, str]:
    """Return ``(path, source)`` for the directory the gallery reads.

    An explicit ``gallery_output_path`` wins so the gallery also works where
    ComfyUI is not installed locally (standalone mode has no real
    ``folder_paths``). Otherwise ComfyUI's own output directory is used, which is
    the documented default. ``source`` is ``setting``, ``comfyui`` or ``unset``.
    """
    configured = ""
    if settings is not None:
        configured = str(settings.get("gallery_output_path") or "").strip()
    if configured:
        return os.path.abspath(os.path.expanduser(configured)), "setting"

    try:
        import folder_paths  # type: ignore[import-not-found]

        getter = getattr(folder_paths, "get_output_directory", None)
        if callable(getter):
            path = getter()
            if path:
                return os.path.abspath(path), "comfyui"
    except Exception as exc:  # pragma: no cover - depends on the host
        logger.debug("ComfyUI output directory unavailable: %s", exc)

    return "", "unset"


def iter_image_paths(root: str, *, recursive: bool = True) -> Iterator[str]:
    """Yield image files under *root*, newest-directory order not guaranteed."""
    if not root or not os.path.isdir(root):
        return

    count = 0
    if recursive:
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if os.path.splitext(name)[1].lower() not in GALLERY_IMAGE_EXTENSIONS:
                    continue
                count += 1
                if count > MAX_IMAGES_PER_SCAN:
                    logger.warning(
                        "Gallery scan hit the %d image limit under %s", MAX_IMAGES_PER_SCAN, root
                    )
                    return
                yield os.path.join(dirpath, name)
        return

    try:
        with os.scandir(root) as entries:
            for entry in entries:
                try:
                    if not entry.is_file():
                        continue
                except OSError:
                    continue
                if os.path.splitext(entry.name)[1].lower() not in GALLERY_IMAGE_EXTENSIONS:
                    continue
                count += 1
                if count > MAX_IMAGES_PER_SCAN:
                    logger.warning(
                        "Gallery scan hit the %d image limit under %s", MAX_IMAGES_PER_SCAN, root
                    )
                    return
                yield entry.path
    except OSError as exc:
        logger.warning("Could not list %s: %s", root, exc)


def detect_parser(fields: Dict[str, Optional[str]]) -> str:
    """Name the metadata flavour an image carries."""
    if fields.get("prompt"):
        return "comfy"
    if fields.get("workflow"):
        return "comfy_workflow"
    parameters = fields.get("parameters") or fields.get("comment") or ""
    stripped = parameters.lstrip()
    if stripped.startswith("{"):
        return "comfy"
    if "Steps:" in parameters:
        return "automatic"
    return "unknown"


def parse_image(
    image_path: str,
    *,
    artist_index: Optional[ArtistIndex] = None,
    lora_index: Optional[Dict[str, Optional[str]]] = None,
    read_metadata: bool = True,
) -> Dict[str, Any]:
    """Build the cache record for one image.

    Never raises for a single bad file: an unreadable image still appears in the
    gallery with ``has_metadata`` false, because the user can still rate it.
    """
    index = artist_index or EMPTY_ARTIST_INDEX
    record: Dict[str, Any] = {
        "image_path": image_path,
        "file_name": os.path.basename(image_path),
        "mtime": 0.0,
        "size": 0,
        "width": None,
        "height": None,
        "prompt": None,
        "negative_prompt": None,
        "parser": None,
        "gen_params": {},
        "artists": [],
        "loras": [],
        "has_metadata": False,
    }

    try:
        stat = os.stat(image_path)
        record["mtime"] = stat.st_mtime
        record["size"] = stat.st_size
    except OSError as exc:
        logger.debug("Could not stat %s: %s", image_path, exc)
        return record

    dimensions = ExifUtils.get_image_dimensions(image_path)
    if dimensions:
        record["width"], record["height"] = dimensions

    if not read_metadata:
        return record

    try:
        fields = ExifUtils._load_structured_metadata(image_path)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("Metadata read failed for %s: %s", image_path, exc)
        return record

    if not any(fields.values()):
        return record

    try:
        result = extract_generation_metadata(fields, sampler_id="", prefer_saved_image_metadata=True)
    except (MetadataError, ValueError, TypeError) as exc:
        logger.debug("No usable generation metadata in %s: %s", image_path, exc)
        record["parser"] = detect_parser(fields)
        return record
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("Unexpected metadata failure for %s: %s", image_path, exc)
        record["parser"] = detect_parser(fields)
        return record

    prompt = result.values.get("positive") or ""
    negative = result.values.get("negative") or ""
    record["prompt"] = prompt or None
    record["negative_prompt"] = negative or None
    record["parser"] = detect_parser(fields)
    record["has_metadata"] = True
    record["gen_params"] = {
        key: value for key, value in result.values.items() if key not in _PROMPT_KEYS
    }

    # Artists are read from the positive prompt only. Anima's recommended
    # negative prompt contains the literal words "artist name", so scanning the
    # negative side would manufacture a phantom artist.
    record["artists"] = extract_artists(prompt, index)

    lora_index = lora_index or {}
    loras: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for name, model_weight, _clip_weight in result.loras:
        lora_name = (name or "").strip()
        if not lora_name or lora_name in seen:
            continue
        seen.add(lora_name)
        installed, digest = resolve_lora(lora_name, lora_index)
        loras.append(
            {
                "name": lora_name,
                "weight": model_weight,
                "exists_locally": installed,
                "hash": digest,
            }
        )
    record["loras"] = loras
    return record


# Model containers we may see in a library. Used to drop a real extension
# without eating the dots inside a name like `Marvel vs. Capcom 2`.
_MODEL_EXTENSIONS = (
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".sft",
    ".gguf",
    ".onnx",
    ".msgpack",
)

# Version markers carry no identity: `x v1.0`, `x_v10` and `x` are the same
# model as far as "is it installed?" goes.
_VERSION_PATTERN = re.compile(r"\bv\d+(?:\s+\d+)*\b|\bver(?:sion)?\s+\d+\b|\b\d+\.\d+\b")
_VERSION_TOKEN_PATTERN = re.compile(r"^v\d+$")


def _strip_model_extension(name: str) -> str:
    lowered = name.lower()
    for extension in _MODEL_EXTENSIONS:
        if lowered.endswith(extension):
            return name[: -len(extension)]
    return name


def normalize_lora_name(name: str) -> str:
    """Spelling-insensitive identity for a LoRA name.

    The same model is spelled differently by the three sources we mix: the file
    name on disk, CivitAI's model name, and the reference embedded in a prompt.
    Case, separators (``_``/``-``/``.``) and punctuation around the words carry
    no meaning, so both sides collapse to lower-case words.
    """
    if not name:
        return ""
    base = os.path.basename(str(name).replace("\\", "/")).strip()
    base = _strip_model_extension(base)
    if not base:
        return ""
    words = re.sub(r"[^0-9A-Za-z]+", " ", base)
    return " ".join(words.lower().split())


def _strip_version_markers(normalized: str) -> str:
    """Drop ``v1``/``v1.0``/``ver 2`` decorations from a normalized name."""
    without_versions = _VERSION_PATTERN.sub(" ", normalized or "")
    return " ".join(without_versions.split())


def _strip_leading_brackets(name: str) -> str:
    """Drop balanced ``[...]`` / ``(...)`` groups at the start of a name.

    ``[Marvel Comics (Capcom)] Marvel vs. Capcom 2`` is the same file as
    ``Marvel vs. Capcom 2``, and the decoration can contain its own brackets.
    """
    text = (name or "").strip()
    while text and text[0] in "[(":
        depth = 0
        closed_at = -1
        for index, char in enumerate(text):
            if char in "[(":
                depth += 1
            elif char in "])":
                depth -= 1
                if depth == 0:
                    closed_at = index
                    break
        if closed_at < 0:
            break
        text = text[closed_at + 1 :].lstrip()
    return text


def _sorted_words(normalized: str) -> str:
    return " ".join(sorted(normalized.split()))


def _lora_name_variants(name: str) -> List[str]:
    """The spellings worth comparing for one LoRA name, best first."""
    if not name:
        return []
    base = os.path.basename(str(name).replace("\\", "/")).strip()
    without_extension = _strip_model_extension(base)
    variants: List[str] = []

    def add(candidate: str) -> None:
        candidate = (candidate or "").strip()
        if candidate and candidate not in variants:
            variants.append(candidate)

    add(str(name).strip())
    add(base)
    add(without_extension)

    stripped = _strip_leading_brackets(without_extension)
    if stripped and stripped != without_extension:
        add(stripped)

    # Normalized spellings come last so an exact match always wins.
    for raw in (without_extension, stripped):
        if not raw:
            continue
        normalized = normalize_lora_name(raw)
        if not normalized:
            continue
        add(normalized)
        no_versions = _strip_version_markers(normalized)
        if no_versions:
            add(no_versions)
        add(_sorted_words(normalized))
        if no_versions:
            add(_sorted_words(no_versions))
    return variants


def _lora_name_keys(item: Dict[str, Any]) -> List[str]:
    """Every spelling a prompt might use for one library LoRA.

    A prompt can reference ``style_a.safetensors``, the same file through a
    subfolder, the ``<lora:name:weight>`` syntax without the extension, or a name
    that only differs in punctuation, case, a ``[creator]`` prefix or a version
    suffix, so all of those resolve.
    """
    keys: List[str] = []
    for field in ("file_name", "model_name", "file_path"):
        value = item.get(field)
        if not isinstance(value, str) or not value:
            continue
        for candidate in _lora_name_variants(value):
            if candidate not in keys:
                keys.append(candidate)
    return keys


def _name_tokens(name: str) -> Set[str]:
    """Token bag used by the last-resort fuzzy comparison."""
    stripped = _strip_leading_brackets(
        _strip_model_extension(os.path.basename(str(name or "").replace("\\", "/")))
    )
    return set(normalize_lora_name(stripped).split())


class LoraIndex(dict):
    """``alias -> sha256`` plus the token bags used when a name drifted.

    ``None`` as a value means "the library has it, but the digest is unknown"
    (ambiguous name, or a hash the scanner has not computed yet): that still
    counts as installed, it just cannot be linked to a model page.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.token_bags: List[Tuple[frozenset, Optional[str]]] = []


def build_lora_index(scanner_cache: Any) -> "LoraIndex":
    """Map every name a prompt may use to the local LoRA's sha256.

    Every library entry is indexed, including the ones whose digest is still
    pending: "installed" and "linkable" are different questions, and answering
    the first one wrong is what makes the gallery claim a LoRA the user owns is
    missing.
    """
    index = LoraIndex()
    try:
        raw = getattr(scanner_cache, "raw_data", None) or []
    except Exception:  # pragma: no cover - defensive
        return index

    for item in raw:
        if not isinstance(item, dict):
            continue
        keys = _lora_name_keys(item)
        if not keys:
            continue
        digest = item.get("sha256")
        digest = digest if isinstance(digest, str) and digest else None
        for key in keys:
            if key not in index:
                index[key] = digest
            elif digest and index[key] and index[key] != digest:
                # Same name, different models: stop claiming to know the digest.
                index[key] = None
        tokens = _name_tokens(item.get("file_name") or item.get("model_name") or "")
        if tokens:
            index.token_bags.append((frozenset(tokens), digest))
    return index


def _fuzzy_match(name: str, index: "LoraIndex") -> Optional[Tuple[bool, Optional[str]]]:
    """Last resort: highest token overlap, but only when it is unambiguous."""
    bags = getattr(index, "token_bags", None) or []
    if not bags:
        return None
    wanted = _name_tokens(name)
    if not wanted:
        return None
    version_tokens = {token for token in wanted if _VERSION_TOKEN_PATTERN.match(token)}

    best_score = 0.0
    second_score = 0.0
    best_digests: Set[Optional[str]] = set()
    for bag, digest in bags:
        if version_tokens and not version_tokens.issubset(bag):
            # 2 must never fuzzy-match 3.
            continue
        union = wanted | bag
        if not union:
            continue
        overlap = len(wanted & bag)
        if wanted <= bag or bag <= wanted:
            # One name is the other plus decoration/version words: that is the
            # common "prompt uses a shorter spelling" case, not a different model.
            score = max(0.9, overlap / len(union))
        else:
            score = overlap / len(union)
        if score > best_score + 1e-9:
            second_score = best_score
            best_score = score
            best_digests = {digest}
        elif abs(score - best_score) <= 1e-9:
            best_digests.add(digest)
        elif score > second_score:
            second_score = score

    if best_score < 0.82:
        return None
    # A close second candidate means the name is genuinely ambiguous.
    if 0.7 <= second_score < best_score - 1e-9:
        return None
    # Two different models tied for the best score: do not guess.
    if len(best_digests) > 1:
        return None
    return True, next(iter(best_digests))


def resolve_lora(name: str, index: Dict[str, Optional[str]]) -> Tuple[bool, Optional[str]]:
    """Resolve a prompt LoRA reference to ``(installed, sha256)``.

    ``installed`` is the question the gallery chips ask; the digest is only
    needed to link the chip to the model page.
    """
    if not name or not index:
        return False, None
    for candidate in _lora_name_variants(name):
        if candidate in index:
            return True, index[candidate]
    fuzzy = _fuzzy_match(name, index)
    if fuzzy is not None:
        return fuzzy
    return False, None


def resolve_lora_hash(name: str, index: Dict[str, Optional[str]]) -> Optional[str]:
    """Resolve one prompt LoRA reference to a local hash, or ``None``."""
    installed, digest = resolve_lora(name, index)
    return digest if installed else None
