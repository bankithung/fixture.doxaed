import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

import { api } from "@/api/client";
import { PublicLeaders } from "../PublicLeaders";

const board = (key: string, teamId: string, teamName: string) => ({
  key,
  label: "Match wins",
  subject: "team" as const,
  fmt: "int",
  rows: [{ team_id: teamId, team_name: teamName, value: 1 }],
});

const PAYLOAD = {
  played: 4,
  latest_badges: [],
  sports: [
    {
      sport: "sepak_takraw",
      name: "Sepak Takraw",
      played: 3,
      boards: [board("wins", "s1", "Sepak Wide School")],
      categories: [
        {
          leaf_key: "sepak.u14.girls",
          label: "u-14 girls",
          played: 2,
          boards: [board("wins", "s2", "Girls Leader School")],
        },
        {
          leaf_key: "sepak.u14.boys",
          label: "u-14 boys",
          played: 0,
          boards: [board("wins", "s3", "Boys Leader School")],
        },
      ],
    },
    {
      sport: "table_tennis",
      name: "Table Tennis",
      played: 1,
      boards: [board("wins", "t1", "Paddle School")],
      categories: [],
    },
  ],
};

function mount(leafKey?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PublicLeaders slug="cup" id="t1" leafKey={leafKey} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue(PAYLOAD);
});

describe("PublicLeaders", () => {
  it("pools every sport when no competition is open", async () => {
    mount();
    expect(await screen.findByText("Sepak Wide School")).toBeInTheDocument();
    expect(screen.getByText("Paddle School")).toBeInTheDocument();
    expect(screen.getByTestId("public-leaders")).toHaveTextContent(
      "4 matches played",
    );
  });

  it("shows ONLY the open competition's board, off the same payload", async () => {
    mount("sepak.u14.girls");
    expect(await screen.findByText("Girls Leader School")).toBeInTheDocument();
    // neither the sport-wide roll-up nor the other sport leaks in
    expect(screen.queryByText("Sepak Wide School")).toBeNull();
    expect(screen.queryByText("Paddle School")).toBeNull();
    expect(screen.getByTestId("public-leaders")).toHaveTextContent(
      "2 matches played",
    );
  });

  it("renders nothing for a competition that has not played yet", async () => {
    mount("sepak.u14.boys");
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("public-leaders")).toBeNull(),
    );
  });

  it("renders nothing for a competition the payload does not know", async () => {
    mount("football.u15");
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("public-leaders")).toBeNull(),
    );
  });
});
