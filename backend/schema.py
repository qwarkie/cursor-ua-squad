# schema.py — Pydantic JSON Schema -> the strict subset OpenAI structured outputs accepts.
# COPY: keep beside clients.py. Only the OpenAI path uses it; Anthropic takes the model class directly.
# CHANGE: add a keyword to _UNSUPPORTED_KEYS if OpenAI rejects your schema with "unsupported keyword".

from __future__ import annotations

from typing import Any

# OpenAI strict mode rejects these outright. Anthropic accepts them, so they are only
# dropped on the fallback path — which is why the README says keep result models flat.
_UNSUPPORTED_KEYS = {"default", "minLength", "maxLength", "pattern", "format", "minimum",
                     "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
                     "minItems", "maxItems", "examples"}


def strict_schema(node: Any) -> Any:
    """Strip unsupported keywords; force additionalProperties=false and required=all on objects."""
    if isinstance(node, dict):
        out = {k: strict_schema(v) for k, v in node.items() if k not in _UNSUPPORTED_KEYS}
        if out.get("type") == "object" or "properties" in out:
            out["additionalProperties"] = False
            out["required"] = list(out.get("properties", {}).keys())
        return out
    if isinstance(node, list):
        return [strict_schema(v) for v in node]
    return node
