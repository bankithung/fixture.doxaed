import { create } from "zustand";

export type Theme = "light" | "dark" | "system";
type Resolved = "light" | "dark";

const STORAGE_KEY = "fixture.theme";

function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

function resolve(theme: Theme): Resolved {
  return theme === "system" ? (prefersDark() ? "dark" : "light") : theme;
}

function apply(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolve(theme) === "dark");
}

function readStored(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

interface ThemeState {
  theme: Theme;
  resolved: Resolved;
  setTheme: (t: Theme) => void;
  /** Apply current theme + subscribe to OS changes while in `system`. */
  init: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStored(),
  resolved: resolve(readStored()),
  setTheme: (t) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, t);
    apply(t);
    set({ theme: t, resolved: resolve(t) });
  },
  init: () => {
    const t = get().theme;
    apply(t);
    set({ resolved: resolve(t) });
    if (typeof window !== "undefined" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener?.("change", () => {
        if (get().theme === "system") {
          apply("system");
          set({ resolved: resolve("system") });
        }
      });
    }
  },
}));
