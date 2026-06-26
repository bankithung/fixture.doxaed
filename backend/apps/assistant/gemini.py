"""Thin Gemini (Google Generative Language) REST client for the setup assistant.

Server-side ONLY — the API key lives in settings (env), never reaches the
browser. We speak the v1beta ``generateContent`` protocol directly via httpx so
we carry no extra SDK dependency (and stay Python 3.14-safe). The function-call
loop that drives the tools lives in ``service.py``; this module is the transport.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx
from django.conf import settings

logger = logging.getLogger(__name__)

_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiError(RuntimeError):
    """A Gemini call failed (missing key, network, non-200, or malformed body).

    The string value is a stable code (e.g. ``gemini_not_configured``,
    ``gemini_unreachable``, ``gemini_http_429``) the view maps to a status.
    """


def configured() -> bool:
    return bool((getattr(settings, "GEMINI_API_KEY", "") or "").strip())


def _endpoint(model: str, key: str) -> str:
    return f"{_BASE}/{model}:generateContent?key={key}"


def generate(
    *,
    system_text: str,
    contents: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    temperature: float = 0.2,
    timeout: float = 45.0,
) -> dict[str, Any]:
    """One ``generateContent`` round-trip. Returns the parsed JSON response.

    Raises :class:`GeminiError` on any failure so the caller maps it to a
    friendly message instead of leaking a 500.
    """
    key = (getattr(settings, "GEMINI_API_KEY", "") or "").strip()
    if not key:
        raise GeminiError("gemini_not_configured")
    model = getattr(settings, "GEMINI_MODEL", "gemini-2.5-flash")

    body: dict[str, Any] = {
        "system_instruction": {"parts": [{"text": system_text}]},
        "contents": contents,
        "generationConfig": {"temperature": temperature},
    }
    if tools:
        body["tools"] = [{"function_declarations": tools}]
        body["tool_config"] = {"function_calling_config": {"mode": "AUTO"}}

    try:
        resp = httpx.post(_endpoint(model, key), json=body, timeout=timeout)
    except httpx.HTTPError as exc:
        logger.warning("Gemini network error: %s", exc)
        raise GeminiError("gemini_unreachable") from exc

    if resp.status_code != 200:
        logger.warning("Gemini HTTP %s: %s", resp.status_code, resp.text[:400])
        raise GeminiError(f"gemini_http_{resp.status_code}")
    try:
        return resp.json()
    except ValueError as exc:
        raise GeminiError("gemini_bad_json") from exc


def candidate_content(resp: dict[str, Any]) -> dict[str, Any]:
    """The model turn to echo back into ``contents`` for the next call —
    returned verbatim so the ``thoughtSignature`` (required by 2.5 thinking
    models when continuing a function-call) is preserved."""
    cands = resp.get("candidates") or []
    if not cands:
        return {"role": "model", "parts": []}
    return cands[0].get("content") or {"role": "model", "parts": []}


def parts_of(resp: dict[str, Any]) -> list[dict[str, Any]]:
    return (candidate_content(resp).get("parts")) or []


def function_calls(resp: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Extract ``(name, args)`` for every functionCall part in the reply."""
    out: list[tuple[str, dict[str, Any]]] = []
    for p in parts_of(resp):
        fc = p.get("functionCall")
        if fc and fc.get("name"):
            out.append((fc["name"], dict(fc.get("args") or {})))
    return out


def text_of(resp: dict[str, Any]) -> str:
    return "".join(p.get("text", "") for p in parts_of(resp)).strip()
