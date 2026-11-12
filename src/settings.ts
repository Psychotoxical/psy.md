// Persistent preferences and the session to restore. Unknown or invalid
// stored values fall back to defaults instead of breaking startup.

import type { Language } from "./i18n";

export type ThemeChoice = "system" | "mocha" | "latte";
export type FontChoice = "system" | "inter";
export type ViewMode = "preview" | "split" | "source";

export interface Settings {
  theme: ThemeChoice;
  language: Language;
  font: FontChoice;
  zoom: number;
  marks: boolean;
}

export interface Session {
  lastFile: string | null;
  view: ViewMode;
  toc: boolean;
  split: number;
  /** Reading position: source line at the top of the preview. */
  line: number;
  recent: string[];
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;
export const RECENT_MAX = 10;

export const defaultSettings: Settings = {
  theme: "system",
  language: "en",
  font: "system",
  zoom: 1,
  marks: true,
};

export const defaultSession: Session = {
  lastFile: null,
  view: "preview",
  toc: true,
  split: 0.5,
  line: 1,
  recent: [],
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;

const num = (v: unknown, min: number, max: number, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;

export function clampZoom(z: number): number {
  return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;
}

export function readSettings(raw: Record<string, unknown> | null): Settings {
  const r = raw ?? {};
  return {
    theme: oneOf(r.theme, ["system", "mocha", "latte"], defaultSettings.theme),
    language: oneOf(r.language, ["en", "de"], defaultSettings.language),
    font: oneOf(r.font, ["system", "inter"], defaultSettings.font),
    zoom: clampZoom(num(r.zoom, ZOOM_MIN, ZOOM_MAX, 1)),
    marks: typeof r.marks === "boolean" ? r.marks : defaultSettings.marks,
  };
}

export function readSession(raw: Record<string, unknown> | null): Session {
  const r = raw ?? {};
  const recent = Array.isArray(r.recent)
    ? uniquePaths(r.recent.filter((p): p is string => typeof p === "string")).slice(0, RECENT_MAX)
    : [];
  return {
    lastFile: typeof r.lastFile === "string" ? r.lastFile : null,
    view: oneOf(r.view, ["preview", "split", "source"], defaultSession.view),
    toc: typeof r.toc === "boolean" ? r.toc : defaultSession.toc,
    split: num(r.split, 0.2, 0.8, 0.5),
    line: Math.floor(num(r.line, 1, 1e9, 1)),
    recent,
  };
}

/** Windows paths (drive letter or UNC) compare without regard to case or slash direction. */
function samePath(a: string, b: string): boolean {
  const win = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\");
  if (win(a) && win(b)) {
    const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
    return norm(a) === norm(b);
  }
  return a === b;
}

function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) if (!out.some((q) => samePath(p, q))) out.push(p);
  return out;
}

export function addRecent(recent: string[], path: string): string[] {
  return uniquePaths([path, ...recent]).slice(0, RECENT_MAX);
}
