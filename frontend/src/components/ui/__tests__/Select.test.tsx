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
});
