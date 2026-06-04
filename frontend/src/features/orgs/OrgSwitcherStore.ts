import { create } from "zustand";

/**
 * v1Users.md Appendix B.20: URL slug is the source of truth for the
 * currently-active org. This store is a denormalised mirror so non-routed
 * components (e.g. the AppShell switcher) can read the value without
 * re-parsing useParams. `setSlugFromUrl` is called from a router-aware
 * effect inside <AppShell>; nothing else should write here.
 */
export interface OrgSwitcherState {
  currentSlug: string | null;
  /** Active role view inside the current org (multi-role users — §2.7). */
  activeRole: string | null;
  setSlugFromUrl: (slug: string | null) => void;
  setActiveRole: (role: string | null) => void;
}

export const useOrgSwitcher = create<OrgSwitcherState>((set) => ({
  currentSlug: null,
  activeRole: null,
  setSlugFromUrl: (slug) => set({ currentSlug: slug }),
  setActiveRole: (role) => set({ activeRole: role }),
}));
