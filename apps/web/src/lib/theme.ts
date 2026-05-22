import { create } from "zustand";

export type Theme = "dark" | "light";

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const STORAGE_KEY = "skiff:theme";

function readInitial(): Theme {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === "light" ? "light" : "dark";
}

function applyToDocument(theme: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: readInitial(),
  toggle: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    applyToDocument(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — private mode etc.
    }
    set({ theme: next });
  },
  setTheme: (t) => {
    applyToDocument(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // ignore
    }
    set({ theme: t });
  },
}));
