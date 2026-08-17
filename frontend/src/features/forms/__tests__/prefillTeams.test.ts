import { describe, expect, it } from "vitest";
import type { Section } from "../types";
import { eventCovers, leafOfSection, prefillForSection, teamShapeOf } from "../prefillTeams";

/**
 * A competition step opens with the people who said they play it (owner
 * 2026-08-17). The school already answered "what is this person here for" on
 * the participants sheet; asking again competition by competition is the same
 * question twice.
 */

const LEAF = "table_tennis.u14.boys.singles";

const SECTION: Section = {
  key: "cat_tt",
  title: "Teams — Table Tennis",
  visibility: { field: "categories_table_tennis", op: "includes", value: LEAF },
  fields: [
    {
      key: "teams_tt",
      type: "group",
      label: "Team",
      repeatable: true,
      fields: [
        { key: "team_name_tt", type: "short_text", label: "Team name" },
        {
          key: "staff_tt",
          type: "group",
          label: "Teacher in charge",
          repeatable: true,
          fields: [
            {
              key: "staff_member_tt",
              type: "dropdown",
              label: "Teacher",
              data_source: {
                type: "form_group",
                group: "participant_staff",
                value_field: "staff_id",
                label_field: "staff_full_name",
              },
            },
          ],
        },
        {
          key: "players_tt",
          type: "group",
          label: "Player",
          repeatable: true,
          fields: [
            {
              key: "player_member_tt",
              type: "dropdown",
              label: "Student",
              data_source: {
                type: "form_group",
                group: "participant_students",
                value_field: "participant_id",
                label_field: "participant_name",
              },
            },
          ],
        },
      ],
    },
  ],
};

const ANSWERS = {
  participant_students: [
    // Declared the exact competition.
    { participant_id: "p1", participant_name: "Imli", participant_events: [LEAF] },
    // Declared the whole sport — still counts.
    {
      participant_id: "p2",
      participant_name: "Toshi",
      participant_events: ["table_tennis"],
    },
    // A different sport entirely.
    {
      participant_id: "p3",
      participant_name: "Aben",
      participant_events: ["sepak_takraw"],
    },
    // Said nothing.
    { participant_id: "p4", participant_name: "Nino" },
  ],
  participant_staff: [
    { staff_id: "s1", staff_full_name: "Mr Ao", staff_events: ["table_tennis"] },
    { staff_id: "s2", staff_full_name: "Mrs Kikon", staff_events: ["sepak_takraw"] },
  ],
};

describe("eventCovers", () => {
  it("matches an exact competition and a whole sport, segment-aligned", () => {
    expect(eventCovers(LEAF, LEAF)).toBe(true);
    expect(eventCovers("table_tennis", LEAF)).toBe(true);
    expect(eventCovers("table_tennis.u14", LEAF)).toBe(true);
    // A partial segment is not a prefix.
    expect(eventCovers("table_tenn", LEAF)).toBe(false);
    expect(eventCovers("sepak_takraw", LEAF)).toBe(false);
    expect(eventCovers("", LEAF)).toBe(false);
  });
});

describe("leafOfSection / teamShapeOf", () => {
  it("reads the competition off the section's own visibility rule", () => {
    expect(leafOfSection(SECTION)).toBe(LEAF);
  });

  it("finds the pickers by their binding, not by their slugged names", () => {
    expect(teamShapeOf(SECTION)).toEqual({
      groupKey: "teams_tt",
      playersKey: "players_tt",
      playerPickKey: "player_member_tt",
      staffKey: "staff_tt",
      staffPickKey: "staff_member_tt",
    });
  });
});

describe("prefillForSection", () => {
  it("seeds exactly the people who said they play this competition", () => {
    const patch = prefillForSection(SECTION, ANSWERS)!;
    expect(patch.key).toBe("teams_tt");
    expect(patch.value).toEqual([
      {
        players_tt: [
          { player_member_tt: "p1" },
          { player_member_tt: "p2" },
        ],
        staff_tt: [{ staff_member_tt: "s1" }],
      },
    ]);
  });

  it("never overwrites a team the school already entered", () => {
    expect(
      prefillForSection(SECTION, {
        ...ANSWERS,
        teams_tt: [{ team_name_tt: "Grace A" }],
      }),
    ).toBeNull();
  });

  it("seeds nothing when nobody declared this competition", () => {
    expect(
      prefillForSection(SECTION, {
        participant_students: [
          { participant_id: "p3", participant_events: ["sepak_takraw"] },
        ],
      }),
    ).toBeNull();
  });

  it("ignores a section that is not a competition", () => {
    expect(
      prefillForSection({ key: "institution", title: "Your institution", fields: [] }, ANSWERS),
    ).toBeNull();
  });
});
