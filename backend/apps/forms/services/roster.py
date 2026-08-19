"""Read the rich roster detail back out of a team's originating submission.

The mapper (:mod:`apps.forms.services.mapping`) deliberately keeps only name /
jersey / position / coarse ``dob_year`` on the domain Player rows — the full
date of birth, the uploaded player & coach documents, the coach names and the
team logo stay on the ``FormResponse`` + ``FormFileUpload`` rows. The admin
Teams tab needs all of that, so this module re-parses the submission with the
SAME bindings the mapper used and joins it back to the domain Team/Player rows
(jersey/captain come from the domain side). No schema change, so it works for
data already collected.

**Two shapes, one reader.** An ``inline`` form types a player's name, DOB and
documents on the team row itself. A ``roster_first`` form declares each person
ONCE on the participants sheet and the team row carries only a PICK
(``player_member_<slug>`` = that sheet row's id), so reading the team row alone
finds no name at all — which is exactly why every squad in a roster-first event
was showing "Born —" and no documents beside a child whose school had uploaded
both (owner 2026-08-19). ``_sheet_people`` indexes the sheet and every pick
resolves through it, so the detail a school actually filled in reaches the
admin whichever way the form was built.
"""
from __future__ import annotations

from apps.forms.constants import FormPurpose
from apps.forms.models import Form, FormResponse
from apps.forms.services.uploads import file_meta_for


def _norm(name) -> str:
    return str(name or "").strip().casefold()


def _files(value, meta: dict[str, dict]) -> list[dict]:
    """Resolve a file-field answer (one ref or a list) to display metadata."""
    if value is None:
        return []
    refs = value if isinstance(value, list) else [value]
    out: list[dict] = []
    for ref in refs:
        info = meta.get(str(ref))
        if info:
            out.append(info)
    return out


def _sheet_people(
    b: dict, a: dict, meta: dict[str, dict],
) -> tuple[dict[str, dict], dict[str, dict]]:
    """The participants sheet indexed by its row id: (students, staff).

    Empty for a form generated before the sheet existed (``bindings`` carries no
    ``participants`` block), which is what keeps every inline form reading
    exactly as it did.
    """
    p = b.get("participants") or {}
    if not p:
        return {}, {}
    students: dict[str, dict] = {}
    for row in a.get(p.get("students_group", ""), []) or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get(p.get("student_name", "")) or "").strip()
        rid = str(row.get(p.get("student_id", "")) or "").strip()
        if not name or not rid:
            continue
        students[rid] = {
            "row_id": rid,
            "name": name,
            "dob": row.get(p.get("student_dob", "")) or None,
            "gender": str(row.get(p.get("student_gender", "")) or "").strip(),
            "documents": _files(row.get(p.get("student_docs", "")), meta),
        }
    staff: dict[str, dict] = {}
    for row in a.get(p.get("staff_group", ""), []) or []:
        if not isinstance(row, dict):
            continue
        name = str(row.get(p.get("staff_name", "")) or "").strip()
        rid = str(row.get(p.get("staff_id", "")) or "").strip()
        if not name or not rid:
            continue
        staff[rid] = {
            "row_id": rid,
            "name": name,
            "phone": str(row.get(p.get("staff_phone", "")) or "").strip(),
            "documents": [],
        }
    return students, staff


def _parse_teams(resp: FormResponse, inst_name: str) -> list[dict]:
    """Mirror ``_map_team_registration_multi`` to derive each team row (so names
    line up with the persisted Team rows), but keep the rich fields."""
    form = resp.form
    b = (form.settings or {}).get("bindings", {})
    a = resp.answers or {}
    meta = file_meta_for(form, a)
    students, staff_sheet = _sheet_people(b, a, meta)
    used_by_leaf: dict[str, set[str]] = {}
    teams: list[dict] = []
    for cg in b.get("category_groups", []):
        group_key = cg.get("group")
        tname_key = cg.get("team_name")
        leaf = cg.get("leaf_key") or cg.get("category") or ""
        rows = a.get(group_key, []) or []
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            seen = used_by_leaf.setdefault(leaf, set())
            raw = row.get(tname_key)
            if raw and str(raw).strip():
                name = str(raw).strip()
            else:
                name = inst_name
                base, n = name or "", 2
                while name and name in seen:
                    name = f"{base} {n}"
                    n += 1
            if not name:
                continue
            seen.add(name)

            players = []
            for pr in row.get(cg.get("players_group"), []) or []:
                if not isinstance(pr, dict):
                    continue
                # A roster-first row PICKS a declared person; the name, DOB and
                # documents live on the sheet, not here.
                picked = students.get(
                    str(pr.get(cg.get("player_member", "")) or "").strip()
                )
                pname = pr.get(cg.get("player_name")) or (
                    picked["name"] if picked else None
                )
                if not pname:
                    continue
                players.append({
                    "name": str(pname),
                    "dob": (
                        pr.get(cg.get("player_dob"))
                        or (picked["dob"] if picked else None)
                        or None
                    ),
                    "documents": (
                        _files(pr.get(cg.get("player_docs")), meta)
                        or (picked["documents"] if picked else [])
                    ),
                })
            coaches = []
            for cr in row.get(cg.get("coaches_group"), []) or []:
                if not isinstance(cr, dict):
                    continue
                cname = cr.get(cg.get("coach_name"))
                if not cname:
                    continue
                coaches.append({
                    "name": str(cname),
                    "documents": _files(cr.get(cg.get("coach_docs")), meta),
                })
            # Roster-first teams name their teacher in charge by picking a staff
            # row of the sheet; that is the same "coach strip" line, so it reads
            # in the same place rather than vanishing.
            for sr in row.get(cg.get("staff_group"), []) or []:
                if not isinstance(sr, dict):
                    continue
                picked = staff_sheet.get(
                    str(sr.get(cg.get("staff_member", "")) or "").strip()
                )
                if picked is None:
                    continue
                coaches.append({"name": picked["name"], "documents": []})
            # The logo is asked ONCE on the participants sheet now (owner
            # 2026-08-17), so it lives at the top level; a form generated
            # before that still carries one per team row.
            logo_key = cg.get("team_logo")
            logo = _files(
                row.get(logo_key, a.get(logo_key)) if logo_key else None,
                meta,
            )
            teams.append({
                "leaf_key": leaf,
                "name": name,
                "logo": logo[0] if logo else None,
                "coaches": coaches,
                "players": players,
            })
    return teams


def team_submission_detail(team) -> dict:
    """Logo + coaches + per-player full DOB & documents for one Team, merged
    with its domain players (jersey/captain). Empty-but-valid when the team was
    added directly (no submission) or its row can't be located."""
    domain_players = [
        {
            "id": str(p.id),
            "name": p.person.full_name if p.person_id else "",
            "jersey_no": p.jersey_no,
            "position": p.position,
            "captain": p.captain,
            "dob": None,
            "documents": [],
        }
        for p in getattr(team, "roster", None) or team.players.filter(
            deleted_at__isnull=True
        ).select_related("person").order_by("jersey_no", "created_at")
    ]
    base = {
        "team_id": str(team.id),
        "logo": None,
        "coaches": [],
        "players": domain_players,
    }
    if not team.institution_id:
        return base

    # Latest non-deleted team-registration submission for this institution.
    forms = list(
        Form.objects.filter(
            tournament_id=team.tournament_id,
            purpose=FormPurpose.TEAM_REGISTRATION,
            deleted_at__isnull=True,
        )
    )
    resp = None
    for form in forms:
        iid_key = (form.settings or {}).get("bindings", {}).get(
            "institution_id", "institution_id"
        )
        resp = (
            FormResponse.objects.filter(
                form=form,
                deleted_at__isnull=True,
                **{f"answers__{iid_key}": str(team.institution_id)},
            )
            .select_related("form")
            .order_by("-created_at")
            .first()
        )
        if resp is not None:
            break
    if resp is None:
        return base

    parsed = _parse_teams(resp, team.institution.name)
    match = next(
        (
            d
            for d in parsed
            if d["name"] == team.name and d["leaf_key"] == (team.leaf_key or d["leaf_key"])
        ),
        None,
    )
    if match is None:
        return base

    # Join submission players (dob + docs) onto the domain rows by name; a
    # positional fallback covers duplicate names within a team.
    sub = list(match["players"])
    by_name: dict[str, list[dict]] = {}
    for s in sub:
        by_name.setdefault(_norm(s["name"]), []).append(s)
    used = set()
    for i, dp in enumerate(domain_players):
        bucket = by_name.get(_norm(dp["name"]))
        s = bucket.pop(0) if bucket else (sub[i] if i < len(sub) and id(sub[i]) not in used else None)
        if s is not None:
            used.add(id(s))
            dp["dob"] = s["dob"]
            dp["documents"] = s["documents"]
    return {
        "team_id": str(team.id),
        "logo": match["logo"],
        "coaches": match["coaches"],
        "players": domain_players,
    }


def participant_documents(tournament, institution_ids) -> dict[str, dict]:
    """``{institution_id: {"by_row": {row_id: [file]}, "by_name": {name: [file]}}}``
    for every school named — the papers a school uploaded per child.

    The documents a school attaches to each participant (age proof, ID, medical
    consent) are asked for on the sheet and land nowhere but the submission:
    ``RosterMember`` deliberately carries only the columns a tournament always
    means the same thing by. So the organizer's participants list reads them
    back here, the same way the Teams tab reads a squad's — no schema change,
    and it works for everything already collected.

    Keyed by the sheet's own row id first (exact, and what a re-submission
    keeps stable) with a name fallback for rows declared before the id was
    persisted onto the member.
    """
    ids = {str(i) for i in institution_ids if i}
    if not ids:
        return {}
    out: dict[str, dict] = {}
    for form in Form.objects.filter(
        tournament=tournament,
        purpose=FormPurpose.TEAM_REGISTRATION,
        deleted_at__isnull=True,
    ):
        b = (form.settings or {}).get("bindings", {})
        if not b.get("participants"):
            continue
        iid_key = b.get("institution_id", "institution_id")
        # Oldest first, so the newest submission of a school wins the key.
        for resp in (
            FormResponse.objects.filter(form=form, deleted_at__isnull=True)
            .order_by("created_at")
        ):
            a = resp.answers or {}
            iid = str(a.get(iid_key) or "")
            if iid not in ids:
                continue
            meta = file_meta_for(form, a)
            students, staff = _sheet_people(b, a, meta)
            by_row: dict[str, list[dict]] = {}
            by_name: dict[str, list[dict]] = {}
            for person in (*students.values(), *staff.values()):
                if not person["documents"]:
                    continue
                by_row[person["row_id"]] = person["documents"]
                by_name.setdefault(_norm(person["name"]), person["documents"])
            out[iid] = {"by_row": by_row, "by_name": by_name}
    return out
