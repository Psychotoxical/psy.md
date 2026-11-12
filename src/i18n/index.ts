// User interface strings. English is the fallback for every key.

import de from "./de.json";
import en from "./en.json";

export type Language = "en" | "de";
export type Key = keyof typeof en;

const tables: Record<Language, Record<string, string>> = { en, de };
let current: Language = "en";
const listeners = new Set<() => void>();

export function language(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  if (!(lang in tables) || lang === current) return;
  current = lang;
  document.documentElement.lang = lang;
  for (const fn of listeners) fn();
}

export function onLanguageChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in vars ? String(vars[name]) : m,
  );
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = tables[current][key] ?? (en as Record<string, string>)[key] ?? key;
  return format(s, vars);
}

/** Fills `data-i18n`, `data-i18n-title`, `data-i18n-label` and `data-i18n-placeholder`. */
export function applyI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n as Key);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle as Key);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nLabel as Key));
  }
  for (const el of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder as Key);
  }
}

/** Time of day for status lines, in the UI language. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(current === "de" ? "de-DE" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
