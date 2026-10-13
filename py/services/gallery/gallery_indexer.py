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
        resolved = resolve_lora_hash(lora_name, lora_index)
        loras.append(
            {
                "name": lora_name,
                "weight": model_weight,
                "exists_locally": resolved is not None,
                "hash": resolved,
            }
        )
    record["loras"] = loras
    return record


def _lora_name_keys(item: Dict[str, Any]) -> List[str]:
    """Every spelling a prompt might use for one library LoRA.

    A prompt can reference ``style_a.safetensors``, the same file through a
    subfolder, or (in the ``<lora:name:weight>`` syntax) without the extension,
    so all of those resolve.
    """
    keys: List[str] = []
    for field in ("file_name", "model_name", "file_path"):
        value = item.get(field)
        if not isinstance(value, str) or not value:
            continue
        base = os.path.basename(value) if field == "file_path" else value
        for candidate in (base, os.path.splitext(base)[0]):
            if candidate and candidate not in keys:
                keys.append(candidate)
    return keys


def build_lora_index(scanner_cache: Any) -> Dict[str, Optional[str]]:
    """Map every name a prompt may use to the local LoRA's sha256.

    A name matching two different models maps to ``None``: linking a chip to the
    wrong LoRA is worse than not linking it at all, and the caller treats
    ``None`` as "no local match" (which is also how a cold scanner cache
    behaves, so a missing cache never fails a scan).
    """
    index: Dict[str, Optional[str]] = {}
    try:
        raw = getattr(scanner_cache, "raw_data", None) or []
    except Exception:  # pragma: no cover - defensive
        return index

    for item in raw:
        if not isinstance(item, dict):
            continue
        digest = item.get("sha256")
        if not isinstance(digest, str) or not digest:
            continue
        for key in _lora_name_keys(item):
            if key not in index:
                index[key] = digest
            elif index[key] != digest:
                # Same name, different models: stop claiming to know.
                index[key] = None
    return index


def resolve_lora_hash(name: str, index: Dict[str, Optional[str]]) -> Optional[str]:
    """Resolve one prompt LoRA reference to a local hash, or ``None``."""
    if not name or not index:
        return None
    base = os.path.basename(name)
    for candidate in (name, base, os.path.splitext(base)[0]):
        if candidate and candidate in index:
            return index[candidate]
    return None
