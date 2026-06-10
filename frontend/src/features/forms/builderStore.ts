import { create } from "zustand";
import type { Field, FieldType, FormSchema, Section } from "./types";

let counter = 0;
const uid = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/** Human default labels keyed by field type (every value is user-visible; the
 *  builder wraps them in `t()` at render time, not here). */
const DEFAULT_LABEL: Record<string, string> = {
  short_text: "Short answer",
  long_text: "Paragraph",
  single_choice: "Single choice",
  multi_choice: "Checkboxes",
  dropdown: "Dropdown",
  email: "Email",
  phone: "Phone",
  number: "Number",
  date: "Date",
  time: "Time",
  rating: "Rating",
  linear_scale: "Scale",
  address: "Address",
  file_upload: "File upload",
  section_text: "Text block",
  yes_no: "Yes / No",
  group: "Repeating group",
};

const CHOICE_TYPES = new Set<FieldType>([
  "single_choice",
  "multi_choice",
  "dropdown",
]);

function newField(type: FieldType): Field {
  const f: Field = { key: uid("f"), type, label: DEFAULT_LABEL[type] ?? "Field" };
  if (CHOICE_TYPES.has(type)) {
    f.options = [{ value: "opt1", label: "Option 1" }];
  }
  return f;
}

function defaultSchema(): FormSchema {
  return {
    version: 1,
    sections: [{ key: uid("s"), title: "Untitled section", fields: [] }],
  };
}

/** Every field key in the schema (including nested group children). */
function collectKeys(schema: FormSchema): Set<string> {
  const keys = new Set<string>();
  const walk = (fields: Field[]): void => {
    for (const f of fields) {
      keys.add(f.key);
      if (f.fields) walk(f.fields);
    }
  };
  schema.sections.forEach((s) => walk(s.fields));
  return keys;
}

/** A stable, unique variable key from a desired base (suffix on collision). */
function uniqueKey(schema: FormSchema, base: string): string {
  const keys = collectKeys(schema);
  if (!keys.has(base)) return base;
  let n = 2;
  while (keys.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

interface BuilderState {
  schema: FormSchema;
  /** Currently-selected field (drives the inspector). */
  selected: { sectionKey: string; fieldKey: string } | null;
  /** Section that the palette adds fields into (defaults to the first). */
  activeSectionKey: string | null;
  load: (schema: FormSchema) => void;
  addSection: () => void;
  removeSection: (key: string) => void;
  updateSection: (key: string, patch: Partial<Section>) => void;
  addField: (
    sectionKey: string,
    type: FieldType,
    init?: Partial<Field>,
  ) => void;
  updateField: (
    sectionKey: string,
    fieldKey: string,
    patch: Partial<Field>,
  ) => void;
  removeField: (sectionKey: string, fieldKey: string) => void;
  reorderFields: (sectionKey: string, from: number, to: number) => void;
  select: (sectionKey: string, fieldKey: string) => void;
  clearSelection: () => void;
  setActiveSection: (sectionKey: string) => void;
}

function mapSection(
  s: FormSchema,
  key: string,
  fn: (sec: Section) => Section,
): FormSchema {
  return {
    ...s,
    sections: s.sections.map((sec) => (sec.key === key ? fn(sec) : sec)),
  };
}

export const useBuilderStore = create<BuilderState>((set) => ({
  schema: defaultSchema(),
  selected: null,
  activeSectionKey: null,
  load: (schema) =>
    set(() => {
      const next = schema.sections.length ? schema : defaultSchema();
      return {
        schema: next,
        selected: null,
        activeSectionKey: next.sections[0]?.key ?? null,
      };
    }),
  addSection: () =>
    set((st) => {
      const sec: Section = {
        key: uid("s"),
        title: "Untitled section",
        fields: [],
      };
      return {
        schema: { ...st.schema, sections: [...st.schema.sections, sec] },
        activeSectionKey: sec.key,
      };
    }),
  removeSection: (key) =>
    set((st) => {
      const sections = st.schema.sections.filter((s) => s.key !== key);
      return {
        schema: { ...st.schema, sections },
        selected:
          st.selected?.sectionKey === key ? null : st.selected,
        activeSectionKey:
          st.activeSectionKey === key
            ? (sections[0]?.key ?? null)
            : st.activeSectionKey,
      };
    }),
  updateSection: (key, patch) =>
    set((st) => ({
      schema: mapSection(st.schema, key, (sec) => ({ ...sec, ...patch })),
    })),
  addField: (sectionKey, type, init) =>
    set((st) => {
      const field = newField(type);
      if (init) {
        const { key: initKey, ...rest } = init;
        Object.assign(field, rest);
        // A preset can request a meaningful variable key (e.g. "school_name");
        // keep it stable + unique so it reads as a real variable.
        if (initKey) field.key = uniqueKey(st.schema, initKey);
      }
      return {
        schema: mapSection(st.schema, sectionKey, (sec) => ({
          ...sec,
          fields: [...sec.fields, field],
        })),
        selected: { sectionKey, fieldKey: field.key },
        activeSectionKey: sectionKey,
      };
    }),
  updateField: (sectionKey, fieldKey, patch) =>
    set((st) => ({
      schema: mapSection(st.schema, sectionKey, (sec) => ({
        ...sec,
        fields: sec.fields.map((f) =>
          f.key === fieldKey ? { ...f, ...patch } : f,
        ),
      })),
    })),
  removeField: (sectionKey, fieldKey) =>
    set((st) => ({
      schema: mapSection(st.schema, sectionKey, (sec) => ({
        ...sec,
        fields: sec.fields.filter((f) => f.key !== fieldKey),
      })),
      selected:
        st.selected?.sectionKey === sectionKey &&
        st.selected?.fieldKey === fieldKey
          ? null
          : st.selected,
    })),
  reorderFields: (sectionKey, from, to) =>
    set((st) => ({
      schema: mapSection(st.schema, sectionKey, (sec) => {
        const fields = [...sec.fields];
        if (
          from < 0 ||
          to < 0 ||
          from >= fields.length ||
          to >= fields.length
        ) {
          return sec;
        }
        const [m] = fields.splice(from, 1);
        fields.splice(to, 0, m);
        return { ...sec, fields };
      }),
    })),
  select: (sectionKey, fieldKey) =>
    set({ selected: { sectionKey, fieldKey }, activeSectionKey: sectionKey }),
  clearSelection: () => set({ selected: null }),
  setActiveSection: (sectionKey) => set({ activeSectionKey: sectionKey }),
}));
