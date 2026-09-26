import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "yusetu.theme";

function systemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function readPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {}
  return "system";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
}

export function applyThemeFromStorage(): ResolvedTheme {
  const resolved = resolveTheme(readPreference());
  applyResolvedTheme(resolved);
  return resolved;
}

export function setThemePreference(preference: ThemePreference): ResolvedTheme {
  try {
    if (preference === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {}
  const resolved = resolveTheme(preference);
  applyResolvedTheme(resolved);
  return resolved;
}

export function toggleTheme(): ResolvedTheme {
  const next: ResolvedTheme =
    resolveTheme(readPreference()) === "dark" ? "light" : "dark";
  return setThemePreference(next);
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    typeof document !== "undefined"
      ? resolveTheme(readPreference())
      : "light",
  );

  useEffect(() => {
    setResolved(applyThemeFromStorage());

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (readPreference() === "system") {
        setResolved(applyThemeFromStorage());
      }
    };
    media.addEventListener("change", onSystemChange);

    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setResolved(applyThemeFromStorage());
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const nextIsLight = resolved === "dark";

  return (
    <button
      type="button"
      className={`theme-toggle btn btn-ghost btn-sm ${className}`.trim()}
      aria-label={nextIsLight ? "Switch to light theme" : "Switch to dark theme"}
      title={nextIsLight ? "Light theme" : "Dark theme"}
      onClick={() => setResolved(toggleTheme())}
    >
      {nextIsLight ? (
        <svg
          className="theme-toggle-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="3"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.2 3.2l.7.7M12.1 12.1l.7.7M12.8 3.2l-.7.7M3.9 12.1l-.7.7"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg
          className="theme-toggle-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M13.2 9.1A5.5 5.5 0 0 1 6.9 2.8 5.6 5.6 0 1 0 13.2 9.1Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      )}
      <span className="theme-toggle-label">{nextIsLight ? "Light" : "Dark"}</span>
    </button>
  );
}
