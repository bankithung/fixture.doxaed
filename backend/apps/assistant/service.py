"""The agent loop: drive Gemini's function-calling until it returns prose.

Stateless across HTTP requests — the client replays the text transcript each
call, and we rebuild a FRESH system prompt (live setup snapshot) on every model
turn, so the assistant always reasons over current data even after its own edits.
"""
from __future__ import annotations

from typing import Any

from . import gemini
from .context import system_prompt
from .tools import TOOL_DECLARATIONS, dispatch

# A "set everything up" request can be a dozen distinct writes (formats per
# sport/leaf, venues, breaks, clashes) — give the loop room to finish in one turn.
MAX_STEPS = 12
MAX_HISTORY = 30


def _to_contents(messages: list[dict]) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for m in messages[-MAX_HISTORY:]:
        text = str(m.get("content") or "").strip()
        if not text:
            continue
        role = "model" if m.get("role") == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": text}]})
    return contents


def run_assistant(*, tournament, user, messages, request, focus=None) -> dict[str, Any]:
    """Returns ``{"reply": str, "actions": [{label, ok}], "changed": bool}``.

    ``focus`` (optional) names the section/input the user pointed the assistant
    at (via an Ask-AI affordance), so the model interprets the turn in context.
    """
    contents = _to_contents(messages)
    if not contents:
        return {"reply": "Hi! Tell me about your tournament and I'll help set up the fixtures — "
                         "dates, venues, and how each competition plays.",
                "actions": [], "changed": False}

    actions: list[dict] = []
    changed = False

    for _ in range(MAX_STEPS):
        resp = gemini.generate(
            system_text=system_prompt(tournament, focus=focus),
            contents=contents,
            tools=TOOL_DECLARATIONS,
        )
        calls = gemini.function_calls(resp)
        if not calls:
            return {"reply": gemini.text_of(resp) or "Done.",
                    "actions": actions, "changed": changed}

        # Echo the model's function-call turn verbatim (keeps thoughtSignature).
        contents.append(gemini.candidate_content(resp))
        response_parts = []
        for name, args in calls:
            result = dispatch(name, args, tournament=tournament, user=user, request=request)
            actions.append({"label": result.get("message") or name, "ok": bool(result.get("ok"))})
            if result.get("changed"):
                changed = True
                tournament.refresh_from_db()
            response_parts.append({"functionResponse": {"name": name, "response": result}})
        contents.append({"role": "user", "parts": response_parts})

    # Tool budget exhausted — ask once more without tools for a closing summary.
    resp = gemini.generate(
        system_text=system_prompt(tournament), contents=contents, tools=None,
    )
    return {"reply": gemini.text_of(resp) or "I've applied several changes — check the form to confirm.",
            "actions": actions, "changed": changed}
