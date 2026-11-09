import { THEMES, type Theme } from "@lifeflow/shared";

const STORAGE_KEY = "lf-theme";

export type ResolvedTheme = "light" | "dark";

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

export function loadStoredTheme(storage: Pick<Storage, "getItem"> | null): Theme {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return THEMES.includes(value as Theme) ? (value as Theme) : "system";
  } catch {
    return "system";
  }
}

export function storeTheme(storage: Pick<Storage, "setItem"> | null, theme: Theme): void {
  try {
    storage?.setItem(STORAGE_KEY, theme);
  } catch {
    /* armazenamento indisponível: o tema vale só para a sessão */
  }
}

export function applyTheme(theme: Theme): ResolvedTheme {
  const prefersDark =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : false;
  const resolved = resolveTheme(theme, prefersDark);
  document.documentElement.dataset["theme"] = resolved;
  return resolved;
}
