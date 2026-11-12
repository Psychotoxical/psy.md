// The open document as a pure state machine. Every transition that could
// lose text is explicit: external changes never replace local edits unless
// the user chose "discard".

export interface DiskVersion {
  text: string;
  token: string;
  bom: boolean;
  eol: "lf" | "crlf";
  mixedEol: boolean;
}

export interface FileRef {
  sessionId: number;
  path: string;
  name: string;
  dir: string;
}

export type DiskState = "current" | "changed" | "missing" | "error";

export interface Problem {
  code: string;
  detail?: string;
}

export interface DocState {
  file: FileRef;
  /** Disk version the buffer is based on. */
  base: DiskVersion;
  /** Text shown in editor and preview. */
  buffer: string;
  disk: DiskState;
  /** Newer disk version not applied because of local edits. */
  pending: DiskVersion | null;
  conflictKept: boolean;
  problem: Problem | null;
  lastSeq: number;
  lastExternalAt: number | null;
  savedAt: number | null;
}

export type DocAction =
  | { type: "edited"; text: string }
  | { type: "external"; seq: number; version: DiskVersion; at: number }
  | { type: "missing"; seq: number }
  | { type: "readError"; seq: number; problem: Problem }
  | { type: "saved"; text: string; token: string; at: number }
  | { type: "savedAs"; text: string; token: string; at: number; file: FileRef }
  | { type: "keepMine" }
  | { type: "discardMine" };

export function openDoc(file: FileRef, version: DiskVersion): DocState {
  return {
    file,
    base: version,
    buffer: version.text,
    disk: "current",
    pending: null,
    conflictKept: false,
    problem: null,
    lastSeq: 0,
    lastExternalAt: null,
    savedAt: null,
  };
}

export function isDirty(s: DocState): boolean {
  return s.buffer !== s.base.text;
}

/** Whether the disk content differs from what the buffer is based on. */
export function hasConflict(s: DocState): boolean {
  return s.pending !== null;
}

export function reduce(s: DocState, a: DocAction): DocState {
  switch (a.type) {
    case "edited":
      return a.text === s.buffer ? s : { ...s, buffer: a.text };

    case "external": {
      if (a.seq <= s.lastSeq) return s;
      const next = { ...s, lastSeq: a.seq, problem: null };
      if (a.version.token === s.base.token) {
        // Our own save, or the disk returned to the base version.
        return { ...next, disk: "current", pending: null, conflictKept: false };
      }
      if (!isDirty(s)) {
        return {
          ...next,
          base: a.version,
          buffer: a.version.text,
          disk: "current",
          pending: null,
          conflictKept: false,
          lastExternalAt: a.at,
        };
      }
      if (a.version.text === s.buffer) {
        // The disk now holds exactly what the user typed.
        return {
          ...next,
          base: a.version,
          disk: "current",
          pending: null,
          conflictKept: false,
        };
      }
      return { ...next, disk: "changed", pending: a.version, conflictKept: false };
    }

    case "missing":
      if (a.seq <= s.lastSeq) return s;
      return { ...s, lastSeq: a.seq, disk: "missing" };

    case "readError":
      if (a.seq <= s.lastSeq) return s;
      return { ...s, lastSeq: a.seq, disk: "error", problem: a.problem };

    case "saved":
      return {
        ...s,
        base: { ...s.base, text: a.text, token: a.token },
        disk: "current",
        pending: null,
        conflictKept: false,
        problem: null,
        savedAt: a.at,
      };

    case "savedAs":
      return {
        ...s,
        file: a.file,
        base: { ...s.base, text: a.text, token: a.token },
        disk: "current",
        pending: null,
        conflictKept: false,
        problem: null,
        lastSeq: 0,
        savedAt: a.at,
      };

    case "keepMine":
      return s.pending ? { ...s, conflictKept: true } : s;

    case "discardMine":
      if (!s.pending) return s;
      return {
        ...s,
        base: s.pending,
        buffer: s.pending.text,
        pending: null,
        conflictKept: false,
        disk: "current",
      };
  }
}
