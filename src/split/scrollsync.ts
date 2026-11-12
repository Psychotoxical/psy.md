// Maps between source lines and preview offsets for synchronized scrolling.

export interface LineEntry {
  line: number;
  top: number;
}

/** Offset in the preview for a (fractional) source line. Entries are sorted. */
export function lineToOffset(entries: LineEntry[], line: number): number {
  if (entries.length === 0) return 0;
  const first = entries[0] as LineEntry;
  if (line <= first.line) return first.top;
  for (let i = 1; i < entries.length; i++) {
    const b = entries[i] as LineEntry;
    if (line < b.line) {
      const a = entries[i - 1] as LineEntry;
      const span = b.line - a.line;
      return a.top + (span > 0 ? ((line - a.line) / span) * (b.top - a.top) : 0);
    }
  }
  return (entries[entries.length - 1] as LineEntry).top;
}

/** Fractional source line for a preview offset. */
export function offsetToLine(entries: LineEntry[], offset: number): number {
  if (entries.length === 0) return 1;
  const first = entries[0] as LineEntry;
  if (offset <= first.top) return first.line;
  for (let i = 1; i < entries.length; i++) {
    const b = entries[i] as LineEntry;
    if (offset < b.top) {
      const a = entries[i - 1] as LineEntry;
      const span = b.top - a.top;
      return a.line + (span > 0 ? ((offset - a.top) / span) * (b.line - a.line) : 0);
    }
  }
  return (entries[entries.length - 1] as LineEntry).line;
}

export type Pane = "editor" | "preview";

/**
 * Decides which pane drives scrolling. Only the pane the user last touched
 * propagates its position, so a synced scroll never echoes back.
 */
export function createScrollGuard(now: () => number = () => performance.now()) {
  let driver: Pane | null = null;
  const quietUntil: Record<Pane, number> = { editor: 0, preview: 0 };
  return {
    userInput(pane: Pane) {
      driver = pane;
      quietUntil[pane] = 0;
    },
    programmatic(pane: Pane) {
      quietUntil[pane] = now() + 120;
    },
    shouldSync(source: Pane): boolean {
      return driver === source && now() >= quietUntil[source];
    },
  };
}
