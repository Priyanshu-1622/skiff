/** localStorage that never throws (private windows, blocked site data) — callers must work without it. */
export function getStored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function setStored(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable: the setting just won't persist */ }
}
