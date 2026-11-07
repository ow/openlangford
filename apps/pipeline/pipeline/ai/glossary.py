"""Council terms for prompts, from shared/glossary.json (the same file the site's /how-council-works page renders).

    from pipeline.ai.glossary import prompt_block
    system = SYSTEM + "\\n\\n" + prompt_block("resident", only=["carried", "tabled", "readings"])

Two registers: "record" gives how Langford's minutes phrase each term (for stages that read records);
"resident" gives the plain words the site writes instead (for stages that write for residents, per
docs/writing-style.md). A stage that adds this block to its prompt should bump its version when
GLOSSARY_VERSION changes, so --stale rewrites older text.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

GLOSSARY_PATH = Path(__file__).resolve().parents[4] / "shared" / "glossary.json"
PUBLIC_PATH = "/how-council-works"

Register = Literal["record", "resident"]


@lru_cache(maxsize=1)
def load() -> dict:
    return json.loads(GLOSSARY_PATH.read_text())


def terms() -> list[dict]:
    return [t for g in load()["groups"] for t in g["terms"]]


def version() -> int:
    return int(load()["version"])


def stage_labels() -> dict[str, str]:
    """Timeline stage key -> the line residents see (the web app's STAGE_LABELS)."""
    return {k: v for t in terms() for k, v in (t.get("stages") or {}).items()}


def _line(t: dict, register: Register) -> str | None:
    if register == "record":
        if not t.get("in_the_record"):
            return None
        return f"- {t['term']}: {t['in_the_record']} {t['means']}"
    if not t.get("we_write"):
        return None
    return f"- {t['term']}: {t['we_write']}"


def prompt_block(register: Register, only: list[str] | None = None) -> str:
    """A system-prompt block. `only` keeps it to the term ids a stage needs."""
    chosen = terms() if only is None else [t for t in terms() if t["id"] in only]
    lines = [l for t in chosen if (l := _line(t, register))]
    if register == "record":
        heading = f"How Langford's council records phrase things (glossary v{version()}):"
    else:
        heading = (
            f"Council terms and the plain words this site uses for them (the site explains them at {PUBLIC_PATH}; "
            f"glossary v{version()}). Use the plain words, not the term:"
        )
    return "\n".join([heading, *lines])
