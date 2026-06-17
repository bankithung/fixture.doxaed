import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FieldRenderer } from "../fieldRenderers";
import type { Field } from "../types";

const opts = (labels: string[]) =>
  labels.map((l) => ({ value: l.toLowerCase().replace(/\s+/g, "_"), label: l }));

function renderField(field: Field, value: unknown = undefined) {
  const onChange = vi.fn();
  render(<FieldRenderer field={field} value={value} onChange={onChange} />);
  return onChange;
}

describe("FieldRenderer choice-list search", () => {
  const SCHOOLS = [
    "Don Bosco",
    "Grace Higher Secondary",
    "Mount Hermon",
    "Holy Cross",
    "Little Flower",
    "Pilgrim School",
    "Mezhür Higher Secondary",
  ];

  it("multi_choice with >5 options gets a search box that filters", async () => {
    const onChange = renderField(
      {
        key: "schools",
        type: "multi_choice",
        label: "Participating schools",
        options: opts(SCHOOLS),
      } as Field,
      [],
    );

    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
    await userEvent.type(
      screen.getByLabelText("Search Participating schools"),
      "mount",
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);

    await userEvent.click(screen.getByRole("checkbox", { name: "Mount Hermon" }));
    expect(onChange).toHaveBeenCalledWith(["mount_hermon"]);
  });

  it("single_choice with >5 options filters radios; no-matches state shows", async () => {
    renderField({
      key: "school",
      type: "single_choice",
      label: "Your school",
      options: opts(SCHOOLS),
    } as Field);

    const search = screen.getByLabelText("Search Your school");
    await userEvent.type(search, "zzz");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText("No matches.")).toBeInTheDocument();

    await userEvent.clear(search);
    expect(screen.getAllByRole("radio")).toHaveLength(7);
  });

  it("renders a per-option image/logo beside the choice", () => {
    renderField({
      key: "school",
      type: "single_choice",
      label: "School",
      options: [
        { value: "a", label: "Alpha", image: "data:image/png;base64,AAAA" },
        { value: "b", label: "Beta" },
      ],
    } as Field);
    const img = document.querySelector('img[src^="data:image"]');
    expect(img).not.toBeNull();
  });

  it("short choice lists have no search box", () => {
    renderField({
      key: "size",
      type: "single_choice",
      label: "Squad size",
      options: opts(["Five", "Seven", "Eleven"]),
    } as Field);

    expect(screen.queryByLabelText("Search Squad size")).toBeNull();
  });
});

describe("FieldRenderer file uploads", () => {
  it("multi-file upload accumulates every upload ref", async () => {
    const onChange = vi.fn();
    let n = 0;
    const onUpload = vi.fn(async () => `ref-${++n}`);
    render(
      <FieldRenderer
        field={{ key: "docs", type: "file_upload", label: "Docs", multiple: true } as Field}
        value={undefined}
        onChange={onChange}
        onUpload={onUpload}
      />,
    );
    await userEvent.upload(screen.getByLabelText("Docs"), [
      new File(["a"], "a.pdf", { type: "application/pdf" }),
      new File(["b"], "b.pdf", { type: "application/pdf" }),
    ]);
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenLastCalledWith(["ref-1", "ref-2"]);
  });

  it("threads onUpload into a repeatable group's file field", async () => {
    const onChange = vi.fn();
    const onUpload = vi.fn(async () => "ref-x");
    render(
      <FieldRenderer
        field={
          {
            key: "players",
            type: "group",
            label: "Player",
            repeatable: true,
            fields: [{ key: "doc", type: "file_upload", label: "Doc" }],
          } as Field
        }
        value={[{}]}
        onChange={onChange}
        onUpload={onUpload}
      />,
    );
    await userEvent.upload(
      screen.getByLabelText("Doc"),
      new File(["a"], "a.pdf", { type: "application/pdf" }),
    );
    // Before the fix onUpload wasn't passed down → the file fell back to its
    // name and never uploaded.
    await waitFor(() => expect(onUpload).toHaveBeenCalled());
  });

  it("shows a prefilled file's real name + view link, and images as thumbnails", () => {
    render(
      <FieldRenderer
        field={{ key: "logo", type: "file_upload", label: "Team logo" } as Field}
        value="ref-img"
        onChange={vi.fn()}
        fileMeta={{
          "ref-img": {
            name: "crest.png",
            url: "/api/forms/uploads/ref-img/?t=sig",
            content_type: "image/png",
          },
        }}
      />,
    );
    const link = screen.getByRole("link", { name: /crest\.png/i });
    expect(link).toHaveAttribute("href", "/api/forms/uploads/ref-img/?t=sig");
    const img = document.querySelector('img[src="/api/forms/uploads/ref-img/?t=sig"]');
    expect(img).not.toBeNull();
  });

  it("lets the user name a document on a multi-file field and reports it", async () => {
    const onFileLabel = vi.fn();
    render(
      <FieldRenderer
        field={
          { key: "docs", type: "file_upload", label: "Documents", multiple: true } as Field
        }
        value={["ref-pdf"]}
        onChange={vi.fn()}
        onFileLabel={onFileLabel}
        fileMeta={{
          "ref-pdf": {
            name: "scan.pdf",
            url: "/api/forms/uploads/ref-pdf/?t=sig",
            content_type: "application/pdf",
          },
        }}
      />,
    );
    const nameInput = screen.getByLabelText(/document name for scan\.pdf/i);
    await userEvent.type(nameInput, "Aadhaar");
    expect(onFileLabel).toHaveBeenLastCalledWith("ref-pdf", "Aadhaar");
  });

  it("shows a prior document name as the headline, filename beneath", () => {
    render(
      <FieldRenderer
        field={
          { key: "docs", type: "file_upload", label: "Documents", multiple: true } as Field
        }
        value={["ref-pdf"]}
        onChange={vi.fn()}
        onFileLabel={vi.fn()}
        fileMeta={{
          "ref-pdf": {
            name: "scan.pdf",
            label: "Birth certificate",
            url: "/api/forms/uploads/ref-pdf/?t=sig",
            content_type: "application/pdf",
          },
        }}
      />,
    );
    // The link text is the document name; the filename is still shown.
    expect(
      screen.getByRole("link", { name: /birth certificate/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("scan.pdf")).toBeInTheDocument();
  });

  it("does not offer a name input on a single-file field (e.g. a logo)", () => {
    render(
      <FieldRenderer
        field={{ key: "logo", type: "file_upload", label: "Team logo" } as Field}
        value="ref-img"
        onChange={vi.fn()}
        onFileLabel={vi.fn()}
        fileMeta={{
          "ref-img": {
            name: "crest.png",
            url: "/api/forms/uploads/ref-img/?t=sig",
            content_type: "image/png",
          },
        }}
      />,
    );
    expect(screen.queryByLabelText(/document name/i)).toBeNull();
  });

  it("links a non-image upload without a thumbnail", () => {
    render(
      <FieldRenderer
        field={{ key: "doc", type: "file_upload", label: "Doc" } as Field}
        value="ref-pdf"
        onChange={vi.fn()}
        fileMeta={{
          "ref-pdf": {
            name: "id.pdf",
            url: "/api/forms/uploads/ref-pdf/?t=sig",
            content_type: "application/pdf",
          },
        }}
      />,
    );
    expect(screen.getByRole("link", { name: /id\.pdf/i })).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
