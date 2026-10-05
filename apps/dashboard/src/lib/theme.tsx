import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "yusetu.theme";

const CYCLE: ThemePreference[] = ["system", "light", "dark"];

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

/** Cycle system → light → dark → system so system is never abandoned. */
export function cycleThemePreference(): ThemePreference {
  const current = readPreference();
  const idx = CYCLE.indexOf(current);
  const next = CYCLE[(idx + 1) % CYCLE.length] ?? "system";
  setThemePreference(next);
  return next;
}

function preferenceLabel(preference: ThemePreference): string {
  if (preference === "system") return "System";
  if (preference === "light") return "Light";
  return "Dark";
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    typeof document !== "undefined" ? readPreference() : "system",
  );

  useEffect(() => {
    applyThemeFromStorage();
    setPreference(readPreference());

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (readPreference() === "system") {
        applyThemeFromStorage();
      }
    };
    media.addEventListener("change", onSystemChange);

    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        applyThemeFromStorage();
        setPreference(readPreference());
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const label = preferenceLabel(preference);

  return (
    <button
      type="button"
      className={`theme-toggle btn btn-ghost btn-sm ${className}`.trim()}
      aria-label={`Theme: ${label}. Click to cycle.`}
      title={`Theme: ${label}`}
      onClick={() => setPreference(cycleThemePreference())}
    >
      {preference === "dark" ? (
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
      ) : preference === "light" ? (
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
          <rect
            x="2.5"
            y="3.5"
            width="11"
            height="9"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M2.5 6.5h11"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      )}
      <span className="theme-toggle-label">{label}</span>
    </button>
  );
}
