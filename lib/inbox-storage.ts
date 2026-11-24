import type { CardState } from "./inbox-questions";

const CARDS_STORAGE_KEY = "bb-plugin-inbox:cards:v1";
const SELECTION_STORAGE_KEY = "bb-plugin-inbox:selected:v1";

export type InboxSelection = {
  id: number;
  at: number;
  open: boolean;
} | null;

export function readStoredCard(key: string): CardState | undefined {
  try {
    const raw = window.localStorage.getItem(CARDS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Record<string, CardState>;
    return parsed?.[key];
  } catch {
    return undefined;
  }
}

export function writeStoredCard(key: string, state: CardState): void {
  try {
    const raw = window.localStorage.getItem(CARDS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, CardState>) : {};
    parsed[key] = state;
    const keys = Object.keys(parsed);
    if (keys.length > 100) {
      for (const oldKey of keys.slice(0, keys.length - 100)) {
        delete parsed[oldKey];
      }
    }
    window.localStorage.setItem(CARDS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore storage quota or private mode failures
  }
}

export function clearStoredCard(key: string): void {
  try {
    const raw = window.localStorage.getItem(CARDS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, CardState>;
    if (!(key in parsed)) return;
    delete parsed[key];
    window.localStorage.setItem(CARDS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore storage failures
  }
}

export function readStoredSelection(): InboxSelection {
  try {
    const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as InboxSelection;
    if (
      parsed &&
      typeof parsed.id === "number" &&
      typeof parsed.at === "number" &&
      typeof parsed.open === "boolean"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeStoredSelection(selection: InboxSelection): void {
  try {
    if (!selection) {
      window.localStorage.removeItem(SELECTION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      SELECTION_STORAGE_KEY,
      JSON.stringify(selection),
    );
  } catch {
    // Ignore storage failures
  }
}
