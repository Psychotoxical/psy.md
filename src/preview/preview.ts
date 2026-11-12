// The preview pane: requests renderings, applies them without losing the
// reading position, marks external changes, and runs highlighting and
// diagrams afterwards. Stale renderings are discarded.

import { clock } from "../i18n";
import { type Heading, ipc } from "../ipc";
import { type LineEntry, lineToOffset, offsetToLine } from "../split/scrollsync";
import { h } from "../ui/dom";
import { type Anchor, type BlockBox, captureAnchor, resolveAnchor } from "./anchor";
import { type ApplyStats, applyBlocks, buildBlock, chunkPlan, type RenderedBlock } from "./apply";
import { decorate } from "./decorate";
import type { DiagramTheme } from "./mermaid";

export interface ShowOptions {
  /** The text came from another program; mark what changed. */
  external?: boolean;
  /** Replace the whole document (new file). */
  reset?: boolean;
  /** Source line to show at the top after a reset. */
  line?: number;
  /** Keep marks of earlier external updates (the reader has not looked). */
  accumulate?: boolean;
}

export interface ShowResult {
  stats: ApplyStats;
  ms: number;
  headings: Heading[];
  /** Line of the first changed block, if any. */
  changedLine: number | null;
}

/** Change marks of a tab that is not on screen, by block key. */
export interface KeptMarks {
  marks: { key: string; at: number }[];
  since: number | null;
}

export interface PreviewHooks {
  /** The open document (tab) whose folder images and links resolve against. */
  sessionId(): number;
  marksEnabled(): boolean;
  diagramTheme(): DiagramTheme;
  diagramFont(): string;
  beforeApply(): void;
  afterApply(): void;
  afterAsyncWork(): void;
}

const CHUNK_FIRST = 400;
const LARGE = 1500;

export class Preview {
  private blocks: RenderedBlock[] = [];
  private req = 0;
  private applied = 0;
  private entries: LineEntry[] | null = null;
  private headingEls: (HTMLElement | null)[] = [];
  private readonly marks = new Map<Element, number>();
  private removals: { el: Element; at: number }[] = [];
  private marksSince: number | null = null;
  private readonly revLayer: HTMLElement;
  headings: Heading[] = [];
  lastMs = 0;
  private readonly codeQueue: HTMLElement[] = [];
  private highlighting = false;
  private readonly codeObserver: IntersectionObserver;

  constructor(
    readonly pane: HTMLElement,
    readonly doc: HTMLElement,
    private readonly hooks: PreviewHooks,
  ) {
    this.revLayer = h("div", { class: "rev-layer", "aria-hidden": "true" });
    pane.prepend(this.revLayer);
    new ResizeObserver(() => {
      this.entries = null;
      this.drawMarks();
    }).observe(doc);
    this.codeObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.codeObserver.unobserve(e.target);
          this.codeQueue.push(e.target as HTMLElement);
        }
        void this.drainHighlights();
      },
      { root: pane, rootMargin: "1200px 0px" },
    );
  }

  private async drainHighlights(): Promise<void> {
    if (this.highlighting || this.codeQueue.length === 0) return;
    this.highlighting = true;
    try {
      const { highlightOne } = await import("./highlight");
      while (this.codeQueue.length) {
        const pre = this.codeQueue.shift() as HTMLElement;
        if (pre.isConnected && !pre.dataset.hl) {
          try {
            await highlightOne(pre);
          } catch {
            pre.dataset.hl = "plain";
          }
        }
      }
    } finally {
      this.highlighting = false;
    }
    this.hooks.afterAsyncWork();
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  clear(): void {
    this.req++;
    this.blocks = [];
    this.headings = [];
    this.headingEls = [];
    this.entries = null;
    this.clearMarks();
    this.doc.replaceChildren();
  }

  async show(text: string, opts: ShowOptions = {}): Promise<ShowResult | null> {
    const id = ++this.req;
    const reply = await ipc.render(this.hooks.sessionId(), text, id);
    if (id !== this.req) return null;
    this.lastMs = reply.ms;

    const viewportTop = this.pane.scrollTop - this.doc.offsetTop;
    const atTop = this.pane.scrollTop <= 1;
    const atBottom =
      this.pane.scrollTop > 0 &&
      this.pane.scrollTop + this.pane.clientHeight >= this.pane.scrollHeight - 4;
    const anchor: Anchor | null =
      opts.reset || atTop ? null : captureAnchor(this.boxes(), viewportTop);

    this.hooks.beforeApply();
    if (opts.reset) {
      this.doc.replaceChildren();
      this.blocks = [];
      this.clearMarks();
    }

    let stats: ApplyStats;
    if (this.blocks.length === 0 && reply.blocks.length > LARGE) {
      stats = await this.applyChunked(reply.blocks, id);
      if (id !== this.req) return null;
    } else {
      stats = applyBlocks(this.doc, this.blocks, reply.blocks, decorate);
    }
    this.blocks = reply.blocks;
    this.headings = reply.headings;
    this.headingEls = reply.headings.map((hd) => document.getElementById(hd.id));
    this.entries = null;
    this.applied = id;

    if (opts.external && !opts.reset) this.setMarks(stats, opts.accumulate ?? false);
    else this.drawMarks();

    if (opts.reset) {
      this.pane.scrollTop = opts.line && opts.line > 1 ? this.offsetForLine(opts.line) : 0;
    } else if (atBottom) {
      this.pane.scrollTop = this.pane.scrollHeight;
    } else if (anchor) {
      this.pane.scrollTop = resolveAnchor(anchor, this.boxes()) + this.doc.offsetTop;
    }

    this.hooks.afterApply();
    void this.postProcess(id, reply.hasMermaid);

    const changedIdx = stats.changed?.[0] ?? (stats.removed > 0 ? stats.at : null);
    const changedBlock =
      changedIdx !== null
        ? (reply.blocks[changedIdx] ?? reply.blocks[reply.blocks.length - 1])
        : undefined;
    return {
      stats,
      ms: reply.ms,
      headings: reply.headings,
      changedLine: changedBlock?.lineStart ?? null,
    };
  }

  private async applyChunked(next: RenderedBlock[], id: number): Promise<ApplyStats> {
    this.doc.replaceChildren();
    const add = (from: number, to: number) => {
      const target = document.createDocumentFragment();
      for (let i = from; i < to; i++) {
        target.append(decorate(buildBlock((next[i] as RenderedBlock).html)));
      }
      this.doc.append(target);
    };
    for (const [n, [from, to]] of chunkPlan(next.length, CHUNK_FIRST).entries()) {
      if (n > 0) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (id !== this.req) return { fresh: [], changed: null, removed: 0, at: 0 };
      }
      add(from, to);
    }
    return {
      fresh: next.map((_, i) => i),
      changed: next.length ? [0, next.length - 1] : null,
      removed: 0,
      at: 0,
    };
  }

  private async postProcess(id: number, hasMermaid: boolean): Promise<void> {
    const isCurrent = () => id === this.req;
    try {
      // Code is highlighted when it comes near the viewport, so large
      // documents do not pay for blocks nobody scrolls to.
      for (const pre of this.doc.querySelectorAll<HTMLElement>("pre[data-lang]:not([data-hl])")) {
        this.codeObserver.observe(pre);
      }
      if (hasMermaid && isCurrent()) {
        const { renderDiagrams } = await import("./mermaid");
        await renderDiagrams(
          this.doc,
          this.hooks.diagramTheme(),
          this.hooks.diagramFont(),
          isCurrent,
        );
      }
    } catch (e) {
      console.error("post-processing failed", e);
    }
    if (isCurrent()) this.hooks.afterAsyncWork();
  }

  /** Re-renders diagrams with the current theme. */
  async refreshDiagrams(): Promise<void> {
    if (!this.doc.querySelector("figure.diagram")) return;
    const { resetDiagrams, renderDiagrams } = await import("./mermaid");
    resetDiagrams(this.doc);
    const id = this.req;
    await renderDiagrams(
      this.doc,
      this.hooks.diagramTheme(),
      this.hooks.diagramFont(),
      () => id === this.req,
    );
  }

  // ---------------------------------------------------------------- marks

  /**
   * Marks blocks that another program changed. With `accumulate`, marks from
   * earlier updates stay (the reader has not looked since); otherwise the
   * new update replaces them.
   */
  private setMarks(stats: ApplyStats, accumulate: boolean): void {
    if (!this.hooks.marksEnabled()) {
      this.clearMarks();
      return;
    }
    if (!stats.changed && stats.removed === 0) return;
    const now = Date.now();
    if (!accumulate) this.clearMarks();
    for (const el of [...this.marks.keys()]) if (!el.isConnected) this.marks.delete(el);
    this.removals = this.removals.filter((r) => r.el.isConnected);
    const children = [...this.doc.children];
    for (const i of stats.fresh) {
      const el = children[i];
      if (el) this.marks.set(el, now);
    }
    if (!stats.changed && stats.removed > 0) {
      // Only removals: mark the place where the content was.
      const el = children[Math.min(stats.at, children.length - 1)];
      if (el) this.removals.push({ el, at: now });
    }
    this.marksSince ??= now;
    this.drawMarks();
  }

  clearMarks(): void {
    this.marks.clear();
    this.removals = [];
    this.marksSince = null;
    this.revLayer.replaceChildren();
  }

  /** Keys of the blocks on screen, to tell later which ones are new. */
  keys(): Set<string> {
    return new Set(this.blocks.map((b) => b.key));
  }

  /** The marks on screen by block key, so they survive a tab switch. */
  keepMarks(): KeptMarks {
    const children = this.doc.children;
    const marks: { key: string; at: number }[] = [];
    for (let i = 0; i < children.length; i++) {
      const at = this.marks.get(children[i] as Element);
      const key = this.blocks[i]?.key;
      if (at !== undefined && key) marks.push({ key, at });
    }
    return { marks, since: this.marksSince };
  }

  /**
   * Puts kept marks back after a tab is shown again, and marks the blocks the
   * reader has not seen (changed while the tab was in the background).
   */
  restoreMarks(kept: KeptMarks | null, seen: Set<string> | null, changedAt: number | null): void {
    if (!this.hooks.marksEnabled()) return;
    const byKey = new Map(kept?.marks.map((m) => [m.key, m.at]));
    const children = this.doc.children;
    for (let i = 0; i < children.length; i++) {
      const key = this.blocks[i]?.key ?? "";
      const at =
        byKey.get(key) ?? (seen && changedAt !== null && !seen.has(key) ? changedAt : undefined);
      if (at !== undefined) this.marks.set(children[i] as Element, at);
    }
    if (this.marks.size === 0) return;
    this.marksSince = kept?.since ?? changedAt;
    this.drawMarks();
  }

  /** Marked blocks in document order with their source line. */
  private marked(): { el: HTMLElement; line: number; at: number }[] {
    const out: { el: HTMLElement; line: number; at: number }[] = [];
    const children = this.doc.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i] as HTMLElement;
      const at = this.marks.get(el) ?? this.removals.find((r) => r.el === el)?.at;
      if (at !== undefined) out.push({ el, line: this.blocks[i]?.lineStart ?? 0, at });
    }
    return out;
  }

  /** Number of marked blocks, the time of the first marked update, and their lines. */
  markInfo(): { count: number; since: number | null; lines: number[] } {
    const m = this.marked();
    return {
      count: [...this.marks.keys()].filter((e) => e.isConnected).length,
      since: m.length ? this.marksSince : null,
      lines: m.map((x) => x.line),
    };
  }

  /** Scrolls to the next (1) or previous (-1) marked block; returns its line. */
  stepMark(dir: 1 | -1): number | null {
    const y = this.pane.scrollTop - this.doc.offsetTop;
    const list = this.marked();
    const target =
      dir === 1
        ? list.find((m) => m.el.offsetTop > y + 30)
        : [...list].reverse().find((m) => m.el.offsetTop < y - 30);
    if (!target) return null;
    this.pane.scrollTop = target.el.offsetTop + this.doc.offsetTop - 24;
    return target.line;
  }

  /** Scrolls to the first marked block at or after `line` (within `toLine`). */
  showMarkFrom(line: number, toLine: number): boolean {
    const m = this.marked().find((x) => x.line >= line && x.line < toLine);
    if (!m) return false;
    this.pane.scrollTop = m.el.offsetTop + this.doc.offsetTop - 24;
    return true;
  }

  drawMarks(): void {
    this.revLayer.replaceChildren();
    const list = this.marked();
    if (list.length === 0) return;
    const base = this.doc.offsetTop;
    // One bar per run of adjacent marked blocks, labelled with its latest time.
    type Run = { top: number; bottom: number; at: number };
    const runs: Run[] = [];
    for (const { el, at } of list) {
      const removal = !this.marks.has(el);
      const top = removal ? el.offsetTop - 10 : el.offsetTop;
      const bottom = removal ? top + 6 : el.offsetTop + el.offsetHeight;
      const last = runs[runs.length - 1];
      if (last && top <= last.bottom + 40) {
        last.bottom = Math.max(last.bottom, bottom);
        last.at = Math.max(last.at, at);
      } else runs.push({ top, bottom, at });
    }
    for (const r of runs) {
      const bar = h("div", { class: "rev-mark" });
      bar.style.top = `${base + r.top}px`;
      bar.style.height = `${Math.max(6, r.bottom - r.top)}px`;
      bar.append(h("time", {}, clock(r.at)));
      this.revLayer.append(bar);
    }
  }

  // ------------------------------------------------------------- geometry

  private boxes(): BlockBox[] {
    const out: BlockBox[] = [];
    const children = this.doc.children;
    for (let i = 0; i < children.length && i < this.blocks.length; i++) {
      const el = children[i] as HTMLElement;
      const b = this.blocks[i] as RenderedBlock;
      out.push({ key: b.key, line: b.lineStart, top: el.offsetTop, height: el.offsetHeight });
    }
    return out;
  }

  /** Source line to preview offset map from every element with a source position. */
  lineEntries(): LineEntry[] {
    if (this.entries) return this.entries;
    const docTop = this.doc.getBoundingClientRect().top;
    const base = this.doc.offsetTop;
    const raw: LineEntry[] = [];
    for (const el of this.doc.querySelectorAll<HTMLElement>(
      ":scope > [data-sourcepos], :scope > * > [data-sourcepos], li[data-sourcepos], tr[data-sourcepos]",
    )) {
      const m = /^(\d+):/.exec(el.dataset.sourcepos ?? "");
      if (!m) continue;
      raw.push({ line: Number(m[1]), top: el.getBoundingClientRect().top - docTop + base });
    }
    raw.sort((a, b) => a.line - b.line || a.top - b.top);
    const entries: LineEntry[] = [];
    for (const e of raw) {
      const last = entries[entries.length - 1];
      if (last && (e.line <= last.line || e.top < last.top)) continue;
      entries.push(e);
    }
    this.entries = entries;
    return entries;
  }

  invalidateGeometry(): void {
    this.entries = null;
    this.drawMarks();
  }

  offsetForLine(line: number): number {
    return lineToOffset(this.lineEntries(), line);
  }

  topLine(): number {
    return offsetToLine(this.lineEntries(), this.pane.scrollTop);
  }

  /** Index into `headings` of the section at the top of the viewport. */
  currentHeading(): number {
    const y = this.pane.scrollTop - this.doc.offsetTop + 32;
    let current = -1;
    for (let i = 0; i < this.headingEls.length; i++) {
      const el = this.headingEls[i];
      if (!el) continue;
      if (el.offsetTop <= y) current = i;
      else break;
    }
    return current;
  }

  scrollToHeading(id: string): boolean {
    const el = document.getElementById(id);
    if (!el || !this.doc.contains(el)) return false;
    this.pane.scrollTop = el.offsetTop + this.doc.offsetTop - 12;
    return true;
  }

  get isApplied(): boolean {
    return this.applied === this.req;
  }
}
