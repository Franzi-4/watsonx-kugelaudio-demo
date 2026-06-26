"""Port of src/agents/text-cleanup.js — strip LLM echo-question tag-ons."""

import re

ALSO_TAG_ON = re.compile(
    r",\s*also\s+(?:wer|wo|was|wann|wie|warum|welche[rs]?)\b[^.?!]{0,80}\?",
    re.IGNORECASE | re.UNICODE,
)
WELCHE_TAG_ON = re.compile(
    r",\s*welche[rs]?\s+\w+\?$", re.IGNORECASE | re.UNICODE
)
SHORT_ECHO_TAG_ON = re.compile(
    r",\s*(?:was|wann|wo|wie)\s+\w+(?:\s+\w+){0,3}\?$",
    re.IGNORECASE | re.UNICODE,
)


def clean_llm_text(text: str, language: str = "de") -> str:
    if not text or language != "de":
        return text
    out = ALSO_TAG_ON.sub("?", text)
    out = WELCHE_TAG_ON.sub("?", out)
    out = SHORT_ECHO_TAG_ON.sub("?", out)
    out = re.sub(r"\?\s*\?", "?", out)
    return out.strip()
