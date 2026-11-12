// The only module that talks to the shell. Everything is typed here so the
// rest of the frontend never builds command names or payloads by hand.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CmdError {
  code: string;
  detail?: string;
  current?: string;
}

export function isCmdError(e: unknown): e is CmdError {
  return typeof e === "object" && e !== null && "code" in e;
}

export interface StartupState {
  settings: Record<string, unknown> | null;
  session: Record<string, unknown> | null;
  startupFile: string | null;
  platform: "windows" | "macos" | "linux";
}

export interface OpenedDoc {
  sessionId: number;
  path: string;
  name: string;
  dir: string;
  text: string;
  token: string;
  bom: boolean;
  eol: "lf" | "crlf";
  mixedEol: boolean;
  watchError: string | null;
}

export interface Block {
  html: string;
  key: string;
  lineStart: number;
  lineEnd: number;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
  line: number;
}

export interface RenderReply {
  reqId: number;
  ms: number;
  blocks: Block[];
  headings: Heading[];
  hasMermaid: boolean;
}

export interface SaveRequest {
  text: string;
  bom: boolean;
  eol: "lf" | "crlf";
  expectedToken: string | null;
  force: boolean;
  targetPath: string | null;
}

export interface SavedDoc {
  sessionId: number;
  token: string;
  path: string;
  name: string;
  dir: string;
}

export interface DocEvent {
  sessionId: number;
  seq: number;
  kind: "changed" | "missing" | "error";
  text?: string;
  token?: string;
  bom?: boolean;
  eol?: "lf" | "crlf";
  mixedEol?: boolean;
  problem?: CmdError;
}

export interface DragState {
  active: boolean;
  markdown: boolean;
}

export const ipc = {
  loadState: () => invoke<StartupState>("load_state"),
  saveSettings: (value: object) => invoke<void>("save_settings", { value }),
  saveSession: (value: object) => invoke<void>("save_session", { value }),
  openDocument: (path: string) => invoke<OpenedDoc>("open_document", { path }),
  closeDocument: () => invoke<void>("close_document"),
  render: (text: string, reqId: number) => invoke<RenderReply>("render_markdown", { text, reqId }),
  save: (request: SaveRequest) => invoke<SavedDoc>("save_document", { request }),
  pickOpenFile: () => invoke<string | null>("pick_open_file"),
  pickSavePath: (suggestedName: string) =>
    invoke<string | null>("pick_save_path", { suggestedName }),
  resolveLink: (href: string) => invoke<string>("resolve_link", { href }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  setExternalImages: (allowed: boolean) => invoke<void>("set_external_images", { allowed }),
  grantFolder: (dir: string) => invoke<void>("grant_folder", { dir }),
  frontendReady: () => invoke<void>("frontend_ready"),
  closeAck: () => invoke<void>("close_ack"),
  confirmClose: () => invoke<void>("confirm_close"),
  setWindowTheme: (theme: "dark" | "light" | null) => invoke<void>("set_window_theme", { theme }),
  setTitle: (title: string) => invoke<void>("set_title", { title }),
  setLanguage: (lang: string) => invoke<void>("set_language", { lang }),
  perfMark: (name: string, detail?: string) => invoke<void>("perf_mark", { name, detail }),
};

export const events = {
  doc: (fn: (e: DocEvent) => void): Promise<UnlistenFn> =>
    listen<DocEvent>("doc-event", (e) => fn(e.payload)),
  openFile: (fn: (path: string) => void): Promise<UnlistenFn> =>
    listen<string>("open-file", (e) => fn(e.payload)),
  drag: (fn: (s: DragState) => void): Promise<UnlistenFn> =>
    listen<DragState>("drag-state", (e) => fn(e.payload)),
  closeRequested: (fn: () => void): Promise<UnlistenFn> => listen("close-requested", () => fn()),
  menu: (fn: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("menu-action", (e) => fn(e.payload)),
};
