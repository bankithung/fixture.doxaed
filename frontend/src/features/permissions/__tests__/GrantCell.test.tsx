import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { screen } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { GrantCell } from "../GrantCell";
import type { GrantState } from "@/types/user";

function GrantCellHarness({
  initial,
  roleDefault,
}: {
  initial: GrantState;
  roleDefault: boolean;
}): React.ReactElement {
  const [s, setS] = useState<GrantState>(initial);
  return (
    <GrantCell
      state={s}
      roleDefault={roleDefault}
      moduleLabel="Org Settings"
      userLabel="user@example.com"
      onChange={setS}
    />
  );
}

describe("GrantCell", () => {
  it("cycles default -> grant -> deny -> default on click", async () => {
    render(<GrantCellHarness initial="default" roleDefault={true} />);
    const btn = screen.getByRole("switch");
    expect(btn.getAttribute("data-state")).toBe("default");
    await userEvent.click(btn);
    expect(btn.getAttribute("data-state")).toBe("grant");
    await userEvent.click(btn);
    expect(btn.getAttribute("data-state")).toBe("deny");
    await userEvent.click(btn);
    expect(btn.getAttribute("data-state")).toBe("default");
  });

  it("cycles via Space key for keyboard users", async () => {
    render(<GrantCellHarness initial="default" roleDefault={false} />);
    const btn = screen.getByRole("switch");
    btn.focus();
    await userEvent.keyboard(" ");
    expect(btn.getAttribute("data-state")).toBe("grant");
  });

  it("cycles via Enter key", async () => {
    render(<GrantCellHarness initial="grant" roleDefault={false} />);
    const btn = screen.getByRole("switch");
    btn.focus();
    await userEvent.keyboard("{Enter}");
    expect(btn.getAttribute("data-state")).toBe("deny");
  });

  it("includes role-default hint in aria-label when state=default", () => {
    render(<GrantCellHarness initial="default" roleDefault={true} />);
    const btn = screen.getByRole("switch");
    expect(btn.getAttribute("aria-label")).toMatch(/granted by role/i);
  });

  it("aria-checked reflects grant state only", async () => {
    render(<GrantCellHarness initial="default" roleDefault={true} />);
    const btn = screen.getByRole("switch");
    expect(btn.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(btn); // -> grant
    expect(btn.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(btn); // -> deny
    expect(btn.getAttribute("aria-checked")).toBe("false");
  });
});
