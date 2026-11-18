import type { ThemePreference } from "./schema";

export type ResolvedTheme = "light" | "dark";

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

interface ThemeTarget {
  dataset: Record<string, string | undefined>;
  style: { colorScheme: string };
}

/** Set `data-theme` (read by CSS variables) and the native `color-scheme` on the root element. */
export function applyTheme(root: ThemeTarget, theme: ResolvedTheme): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/**
 * Keep the document in sync with the preference and, for "system", with the OS setting.
 * Returns a cleanup function.
 */
export function watchTheme(
  getPreference: () => ThemePreference,
  root: ThemeTarget,
  media: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">,
): { refresh: () => void; stop: () => void } {
  const refresh = () => applyTheme(root, resolveTheme(getPreference(), media.matches));
  media.addEventListener("change", refresh);
  refresh();
  return { refresh, stop: () => media.removeEventListener("change", refresh) };
}
