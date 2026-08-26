"""The judging rubrics, exactly as the competition publishes them.

Two schemes of 100 marks: one for a single photograph, one for the four-photo
story, which is judged as ONE entry rather than four. They live here as data so
the page renders the criteria the judges were told about and the totals cannot
drift from the published rules.
"""
from __future__ import annotations

#: Best Sepaktakraw Photograph and Best Table Tennis Photograph.
PHOTO_RUBRIC: list[dict] = [
    {"key": "timing", "label": "Timing and Action", "max": 30},
    {"key": "composition", "label": "Composition and Framing", "max": 20},
    {"key": "emotion", "label": "Emotion and Story", "max": 15},
    {"key": "technical", "label": "Technical Quality", "max": 15},
    {"key": "originality", "label": "Originality and Visual Impact", "max": 10},
    {"key": "relevance", "label": "Relevance to the Category", "max": 10},
]

#: Beyond the Court: A Photo Story — the four photographs judged together.
STORY_RUBRIC: list[dict] = [
    {"key": "storytelling", "label": "Storytelling and Narrative", "max": 30},
    {"key": "sequence", "label": "Sequence and Connection", "max": 20},
    {"key": "emotion", "label": "Emotion and Human Interest", "max": 15},
    {"key": "originality", "label": "Originality and Creativity", "max": 15},
    {"key": "composition", "label": "Composition and Visual Quality", "max": 10},
    {"key": "relevance", "label": "Relevance to the Tournament", "max": 10},
]

PHOTO_GUIDE = (
    "Does the photograph capture a strong moment, communicate emotion, sit "
    "well in the frame and clearly represent its sport?"
)
STORY_GUIDE = (
    "How well do the four photographs work together to tell a clear, "
    "meaningful and memorable story?"
)


def rubric_for(is_story: bool) -> list[dict]:
    return STORY_RUBRIC if is_story else PHOTO_RUBRIC


def guide_for(is_story: bool) -> str:
    return STORY_GUIDE if is_story else PHOTO_GUIDE


def score_total(rubric: list[dict], marks: dict) -> int:
    """Total for one score sheet, each criterion clamped to its own maximum.

    Clamped rather than rejected: a judge dragging a slider must never be able
    to make an entry worth more than 100, and a rubric that changed after a
    score was saved must not make an old sheet unreadable.
    """
    total = 0
    for row in rubric:
        try:
            value = int(marks.get(row["key"], 0) or 0)
        except (TypeError, ValueError):
            value = 0
        total += max(0, min(value, int(row["max"])))
    return total


def clean_marks(rubric: list[dict], marks) -> dict:
    """Only the criteria this rubric names, each within range."""
    if marks is None:
        return {}
    if not isinstance(marks, dict):
        raise ValueError("marks_must_be_an_object")
    out: dict = {}
    for row in rubric:
        if row["key"] not in marks:
            continue
        try:
            value = int(marks[row["key"]] or 0)
        except (TypeError, ValueError):
            raise ValueError(f"invalid_mark:{row['key']}") from None
        if value < 0 or value > int(row["max"]):
            raise ValueError(f"mark_out_of_range:{row['key']}")
        out[row["key"]] = value
    return out
