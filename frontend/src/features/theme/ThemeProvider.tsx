import { useEffect } from "react";
import { useThemeStore } from "./themeStore";

/** Applies the persisted/system theme on mount and wires OS-change listening. */
export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const init = useThemeStore((s) => s.init);
  useEffect(() => {
    init();
  }, [init]);
  return <>{children}</>;
}
