// Rules for the list of open tabs that do not depend on the window.

import { samePath } from "../settings";

/** Index of the tab showing `path`, or -1. */
export function findTab(paths: readonly string[], path: string): number {
  return paths.findIndex((p) => samePath(p, path));
}

/**
 * The tab to show after tab `closing` of `count` closes while tab `active` is
 * shown: the right neighbour, at the end the left one; -1 when none is left.
 * The result is an index into the list without the closed tab.
 */
export function activeAfterClose(count: number, closing: number, active: number): number {
  if (count <= 1) return -1;
  if (closing === active) return Math.min(closing, count - 2);
  return closing < active ? active - 1 : active;
}

export type CloseKind = "others" | "right" | "all";

/** Indices to close for a context menu choice on tab `at`. */
export function toClose(kind: CloseKind, count: number, at: number): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  if (kind === "others") return all.filter((i) => i !== at);
  if (kind === "right") return all.filter((i) => i > at);
  return all;
}

/** Recently closed files, for reopening them in reverse order. */
export class ClosedTabs {
  private readonly paths: string[] = [];

  constructor(private readonly max = 20) {}

  push(path: string): void {
    this.forget(path);
    this.paths.push(path);
    if (this.paths.length > this.max) this.paths.shift();
  }

  pop(): string | null {
    return this.paths.pop() ?? null;
  }

  has(): boolean {
    return this.paths.length > 0;
  }

  forget(path: string): void {
    const i = findTab(this.paths, path);
    if (i >= 0) this.paths.splice(i, 1);
  }
}
