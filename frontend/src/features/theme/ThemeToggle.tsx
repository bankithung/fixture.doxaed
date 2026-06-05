import { Monitor, Moon, Sun } from "lucide-react";
import { useThemeStore, type Theme } from "./themeStore";
import { t } from "@/lib/t";

const NEXT: Record<Theme, Theme> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const ICON = { light: Sun, dark: Moon, system: Monitor };

/** 3-state theme cycle: light → dark → system. */
export function ThemeToggle(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const Icon = ICON[theme];
  const label = t(`Theme: ${theme}. Switch to ${NEXT[theme]}.`);

  return (
    <button
      type="button"
      onClick={() => setTheme(NEXT[theme])}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden="true" className="h-5 w-5" />
    </button>
  );
}
