"""Match videos the host curates: an album of events, each pointing at wherever
the footage was actually published.

The platform does not host video. A school meet's footage lives on YouTube,
Facebook and Instagram already, and re-uploading it would mean storage,
transcoding and moderation for no gain. So a video here is a LINK — the album
is the running order, and the page plays the YouTube one inline while the other
two are one tap away.
"""
from __future__ import annotations

from django.conf import settings
from django.db import models

from apps.accounts.models import uuid7


class VideoAlbum(models.Model):
    """A named collection of videos inside one tournament ("Day 1", "Finals")."""

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="video_albums",
    )
    tournament = models.ForeignKey(
        "tournaments.Tournament",
        on_delete=models.CASCADE,
        related_name="video_albums",
    )
    title = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    #: Host-authored running order; ties fall back to creation time, newest
    #: first — the album that just opened is the one being filled.
    position = models.PositiveIntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        ordering = ["position", "-created_at"]
        indexes = [
            models.Index(fields=["tournament", "position"], name="video_album_ord_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return self.title


class TournamentVideo(models.Model):
    """One event, and the places its footage was published.

    Every link is optional individually but at least one is required — a video
    entry that points nowhere is not a video.
    """

    id = models.UUIDField(primary_key=True, default=uuid7, editable=False)
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="videos",
    )
    album = models.ForeignKey(
        VideoAlbum, on_delete=models.CASCADE, related_name="videos"
    )
    #: What the footage is OF, in the host's own words ("U-14 Boys Final").
    event = models.CharField(max_length=160)
    note = models.TextField(blank=True, default="")
    youtube_url = models.URLField(max_length=500, blank=True, default="")
    facebook_url = models.URLField(max_length=500, blank=True, default="")
    instagram_url = models.URLField(max_length=500, blank=True, default="")
    #: The day the footage is OF, which is rarely the day it was uploaded —
    #: a viewer looking for "Saturday" means the play, not the post.
    played_on = models.DateField(null=True, blank=True, db_index=True)
    #: The schools in the footage. A match video features two, so this is a
    #: relation rather than a field: a school filter has to find both.
    institutions = models.ManyToManyField(
        "teams.Institution", blank=True, related_name="videos",
    )
    #: Free labels the host adds ("Table Tennis", "U-14", "Final"). Free on
    #: purpose: nothing in the platform should decide what is worth tagging,
    #: and the host's own category tree is offered as suggestions, not rules.
    tags = models.JSONField(default=list, blank=True)
    position = models.PositiveIntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    class Meta:
        ordering = ["position", "-created_at"]
        indexes = [
            models.Index(fields=["album", "position"], name="video_item_ord_idx"),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return self.event
