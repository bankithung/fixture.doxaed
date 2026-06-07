import { beforeEach, describe, expect, it } from "vitest";
import { useBuilderStore } from "@/features/forms/builderStore";

const reset = () =>
  useBuilderStore.getState().load({
    version: 1,
    sections: [{ key: "s1", title: "Section 1", fields: [] }],
  });

describe("builderStore", () => {
  beforeEach(reset);

  it("adds a field with a unique key", () => {
    useBuilderStore.getState().addField("s1", "short_text");
    const s = useBuilderStore.getState().schema.sections[0];
    expect(s.fields).toHaveLength(1);
    expect(s.fields[0].type).toBe("short_text");
    expect(s.fields[0].key).toBeTruthy();
  });

  it("addField twice yields distinct keys", () => {
    useBuilderStore.getState().addField("s1", "short_text");
    useBuilderStore.getState().addField("s1", "short_text");
    const f = useBuilderStore.getState().schema.sections[0].fields;
    expect(f[0].key).not.toBe(f[1].key);
  });

  it("seeds options for choice field types", () => {
    useBuilderStore.getState().addField("s1", "single_choice");
    const f = useBuilderStore.getState().schema.sections[0].fields[0];
    expect(f.options).toHaveLength(1);
  });

  it("updates a field", () => {
    useBuilderStore.getState().addField("s1", "short_text");
    const key = useBuilderStore.getState().schema.sections[0].fields[0].key;
    useBuilderStore
      .getState()
      .updateField("s1", key, { label: "Name", required: true });
    const f = useBuilderStore.getState().schema.sections[0].fields[0];
    expect(f.label).toBe("Name");
    expect(f.required).toBe(true);
  });

  it("removes a field", () => {
    useBuilderStore.getState().addField("s1", "short_text");
    const key = useBuilderStore.getState().schema.sections[0].fields[0].key;
    useBuilderStore.getState().removeField("s1", key);
    expect(useBuilderStore.getState().schema.sections[0].fields).toHaveLength(0);
  });

  it("reorders fields within a section", () => {
    useBuilderStore.getState().addField("s1", "short_text");
    useBuilderStore.getState().addField("s1", "email");
    const before = useBuilderStore
      .getState()
      .schema.sections[0].fields.map((f) => f.type);
    expect(before).toEqual(["short_text", "email"]);
    useBuilderStore.getState().reorderFields("s1", 0, 1);
    const after = useBuilderStore
      .getState()
      .schema.sections[0].fields.map((f) => f.type);
    expect(after).toEqual(["email", "short_text"]);
  });

  it("adds and removes a section", () => {
    useBuilderStore.getState().addSection();
    expect(useBuilderStore.getState().schema.sections).toHaveLength(2);
    const k = useBuilderStore.getState().schema.sections[1].key;
    useBuilderStore.getState().removeSection(k);
    expect(useBuilderStore.getState().schema.sections).toHaveLength(1);
  });

  it("updates a section", () => {
    useBuilderStore.getState().updateSection("s1", { title: "Renamed" });
    expect(useBuilderStore.getState().schema.sections[0].title).toBe("Renamed");
  });

  it("load() supplies a default section for an empty schema", () => {
    useBuilderStore.getState().load({ version: 1, sections: [] });
    expect(
      useBuilderStore.getState().schema.sections.length,
    ).toBeGreaterThanOrEqual(1);
  });
});
