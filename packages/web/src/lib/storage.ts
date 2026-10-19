// Per-viewer conveniences in `localStorage` (the onboarding flag): every access is wrapped, since
// storage can be missing or throw (private windows, blocked site data). Nothing here is needed for
// the page to work.

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readStored(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    const s = store();
    if (s === null) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    // Storage full or blocked: the convenience is lost, nothing else.
  }
}
