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

/** An open tab: the file and its reading position (source line at the top). */
export interface SessionTab {
  path: string;
  line: number;
}

export interface Session {
  tabs: SessionTab[];
  /** Index into `tabs`, or -1 without tabs. */
  activeTab: number;
  view: ViewMode;
  toc: boolean;
  split: number;
  recent: string[];
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;
export const RECENT_MAX = 10;
export const TABS_MAX = 50;

export const defaultSettings: Settings = {
  theme: "system",
  language: "en",
  font: "system",
  zoom: 1,
  marks: true,
};

export const defaultSession: Session = {
  tabs: [],
  activeTab: -1,
  view: "preview",
  toc: true,
  split: 0.5,
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
  const { tabs, activeTab } = readTabs(r);
  return {
    tabs,
    activeTab,
    view: oneOf(r.view, ["preview", "split", "source"], defaultSession.view),
    toc: typeof r.toc === "boolean" ? r.toc : defaultSession.toc,
    split: num(r.split, 0.2, 0.8, 0.5),
    recent,
  };
}

/** Open tabs; a session from before tabs had one `lastFile` with its `line`. */
function readTabs(r: Record<string, unknown>): { tabs: SessionTab[]; activeTab: number } {
  const line = (v: unknown) => Math.floor(num(v, 1, 1e9, 1));
  const raw: { path: string; line: number; index: number }[] = [];
  if (Array.isArray(r.tabs)) {
    r.tabs.forEach((t, index) => {
      if (t && typeof t === "object" && typeof (t as { path?: unknown }).path === "string") {
        const o = t as { path: string; line?: unknown };
        raw.push({ path: o.path, line: line(o.line), index });
      }
    });
  } else if (typeof r.lastFile === "string") {
    raw.push({ path: r.lastFile, line: line(r.line), index: 0 });
  }
  const wanted = typeof r.activeTab === "number" ? r.activeTab : 0;
  const tabs: SessionTab[] = [];
  let activeTab = -1;
  for (const t of raw) {
    let at = tabs.findIndex((x) => samePath(x.path, t.path));
    if (at < 0 && tabs.length < TABS_MAX) {
      tabs.push({ path: t.path, line: t.line });
      at = tabs.length - 1;
    }
    if (t.index === wanted && at >= 0) activeTab = at;
  }
  if (activeTab < 0 && tabs.length) activeTab = 0;
  return { tabs, activeTab };
}

/** Windows paths (drive letter or UNC) compare without regard to case or slash direction. */
export function samePath(a: string, b: string): boolean {
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
