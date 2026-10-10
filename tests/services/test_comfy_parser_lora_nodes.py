"""Regression tests: the recipe ComfyUI parser must see every LoRA loader shape.

``LoraLoaderModelOnly`` was previously ignored, which silently emptied a
recipe's LoRA list for LoRA-only workflows (Anima, Flux, ...).
"""

from __future__ import annotations

import json

from py.recipes.parsers.comfy import ComfyMetadataParser


class StubRecipeScanner:
    """Minimal scanner stub: every name resolves to a local file."""

    class _LoraScanner:
        @staticmethod
        def has_hash(_model_hash):
            return False

    def __init__(self) -> None:
        self.queries: list[str] = []
        self._lora_scanner = self._LoraScanner()

    async def get_local_lora(self, name, base_model=None):  # noqa: ANN001, ARG002
        self.queries.append(name)
        return {
            "file_path": f"/models/loras/{name}",
            "file_name": name,
            "model_name": name,
            "sha256": name[:1].ljust(64, "0"),
            "size": 4096,
            "base_model": "SDXL 1.0",
            "preview_url": "",
            "civitai": None,
        }


def _graph(loader_nodes):
    """Build an API graph whose only LoRA loaders are *loader_nodes*."""
    graph = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "anima-base.safetensors"}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": "1girl, @nnn yryr, smile", "clip": ["1", 1]}},
        "9": {"class_type": "CLIPTextEncode", "inputs": {"text": "worst quality", "clip": ["1", 1]}},
        "10": {"class_type": "EmptyLatentImage", "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
    }
    graph.update(loader_nodes)
    graph["20"] = {
        "class_type": "KSampler",
        "inputs": {
            "model": ["1", 0],
            "positive": ["8", 0],
            "negative": ["9", 0],
            "latent_image": ["10", 0],
            "seed": 1,
            "steps": 30,
            "cfg": 4.5,
            "sampler_name": "er_sde",
            "scheduler": "simple",
            "denoise": 1.0,
        },
    }
    return graph


async def _parse(graph):
    return await ComfyMetadataParser().parse_metadata(
        json.dumps(graph), recipe_scanner=StubRecipeScanner(), civitai_client=None
    )


async def test_lora_loader_model_only_is_recorded():
    """The bug: a LoRA-only workflow produced an empty LoRA list."""
    graph = _graph(
        {
            "2": {
                "class_type": "LoraLoaderModelOnly",
                "inputs": {"model": ["1", 0], "lora_name": "style_b.safetensors", "strength_model": 0.5},
            }
        }
    )
    result = await _parse(graph)
    assert [lora["name"] for lora in result["loras"]] == ["style_b.safetensors"]
    assert result["loras"][0]["weight"] == 0.5


async def test_plain_lora_loader_still_works():
    """Guard the branch that already worked before the fix."""
    graph = _graph(
        {
            "2": {
                "class_type": "LoraLoader",
                "inputs": {
                    "model": ["1", 0],
                    "clip": ["1", 1],
                    "lora_name": "style_a.safetensors",
                    "strength_model": 0.8,
                    "strength_clip": 0.8,
                },
            }
        }
    )
    result = await _parse(graph)
    assert [lora["name"] for lora in result["loras"]] == ["style_a.safetensors"]
    assert result["loras"][0]["weight"] == 0.8


async def test_both_loader_shapes_appear_in_one_recipe():
    graph = _graph(
        {
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
        }
    )
    result = await _parse(graph)
    assert sorted(lora["name"] for lora in result["loras"]) == ["style_a.safetensors", "style_b.safetensors"]


async def test_lora_manager_widget_loader_is_recorded():
    graph = _graph(
        {
            "2": {
                "class_type": "Lora Loader (LoraManager)",
                "inputs": {
                    "model": ["1", 0],
                    "clip": ["1", 1],
                    "loras": [
                        {"name": "widget_a.safetensors", "strength": 0.7, "active": True},
                        {"name": "inactive.safetensors", "strength": 0.9, "active": False},
                    ],
                },
            }
        }
    )
    result = await _parse(graph)
    # Only active entries count.
    assert [lora["name"] for lora in result["loras"]] == ["widget_a.safetensors"]
    assert result["loras"][0]["weight"] == 0.7


async def test_lora_text_loader_is_recorded():
    graph = _graph(
        {
            "2": {
                "class_type": "LoRA Text Loader (LoraManager)",
                "inputs": {"model": ["1", 0], "clip": ["1", 1], "lora_syntax": "<lora:text_style.safetensors:0.6>"},
            }
        }
    )
    result = await _parse(graph)
    assert [lora["name"] for lora in result["loras"]] == ["text_style.safetensors"]
    assert result["loras"][0]["weight"] == 0.6


async def test_unparsable_lora_syntax_does_not_break_the_recipe():
    graph = _graph(
        {
            "2": {
                "class_type": "LoRA Text Loader (LoraManager)",
                "inputs": {"model": ["1", 0], "clip": ["1", 1], "lora_syntax": "<lora:broken"},
            }
        }
    )
    result = await _parse(graph)
    assert result["loras"] == []
