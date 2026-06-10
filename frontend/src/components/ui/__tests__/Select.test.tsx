import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Select } from "../Select";

const OPTS = [
  { value: "a", label: "Apple" },
  { value: "b", label: "Banana" },
];

describe("Select", () => {
  it("opens and selects an option", async () => {
    const onChange = vi.fn();
    render(
      <Select value="" onChange={onChange} options={OPTS} aria-label="Fruit" placeholder="Pick" />,
    );
    const btn = screen.getByRole("button", { name: /fruit/i });
    expect(btn).toHaveTextContent("Pick");

    await userEvent.click(btn);
    await userEvent.click(screen.getByRole("option", { name: "Banana" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("renders the selected option's label", () => {
    render(<Select value="a" onChange={() => {}} options={OPTS} aria-label="Fruit" />);
    expect(screen.getByRole("button", { name: /fruit/i })).toHaveTextContent("Apple");
  });

  it("opens with the keyboard and is a listbox", async () => {
    render(<Select value="" onChange={() => {}} options={OPTS} aria-label="Fruit" />);
    const btn = screen.getByRole("button", { name: /fruit/i });
    btn.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("short lists have no search box", async () => {
    render(<Select value="" onChange={() => {}} options={OPTS} aria-label="Fruit" />);
    await userEvent.click(screen.getByRole("button", { name: /fruit/i }));
    expect(screen.queryByLabelText("Search options")).toBeNull();
  });

  it("lists with more than 5 options get a search box that filters", async () => {
    const MANY = ["Apple", "Banana", "Cherry", "Date", "Elderberry", "Fig", "Grape"]
      .map((l) => ({ value: l.toLowerCase(), label: l }));
    const onChange = vi.fn();
    render(<Select value="" onChange={onChange} options={MANY} aria-label="Fruit" />);

    await userEvent.click(screen.getByRole("button", { name: /fruit/i }));
    const search = screen.getByLabelText("Search options");
    expect(screen.getAllByRole("option")).toHaveLength(7);

    await userEvent.type(search, "gra");
    expect(screen.getAllByRole("option")).toHaveLength(1);

    await userEvent.click(screen.getByRole("option", { name: "Grape" }));
    expect(onChange).toHaveBeenCalledWith("grape");
  });

  it("search supports keyboard selection and shows a no-matches state", async () => {
    const MANY = ["Apple", "Banana", "Cherry", "Date", "Elderberry", "Fig"]
      .map((l) => ({ value: l.toLowerCase(), label: l }));
    const onChange = vi.fn();
    render(<Select value="" onChange={onChange} options={MANY} aria-label="Fruit" />);

    await userEvent.click(screen.getByRole("button", { name: /fruit/i }));
    await userEvent.type(screen.getByLabelText("Search options"), "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches.")).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Search options"));
    await userEvent.type(screen.getByLabelText("Search options"), "fig{Enter}");
    expect(onChange).toHaveBeenCalledWith("fig");
  });
});
