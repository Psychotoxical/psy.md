// Table of contents from the document's headings, with outline numbers
// (unless the headings carry their own) and the current section marked.

import type { Heading } from "../ipc";
import { h } from "../ui/dom";

export interface TocEntry extends Heading {
  number: string;
}

const OWN_NUMBER = /^\s*(\d+(\.\d+)*[.)]?|[IVXLC]+\.|[A-Z]\.)\s/;

/** Outline numbers like 1, 1.1, 2; a single leading top heading is the title. */
export function numberHeadings(headings: Heading[]): TocEntry[] {
  if (headings.length === 0) return [];
  const numbered = headings.filter((x) => OWN_NUMBER.test(x.text)).length;
  if (numbered >= headings.length / 2) return headings.map((x) => ({ ...x, number: "" }));

  const minLevel = Math.min(...headings.map((x) => x.level));
  const topCount = headings.filter((x) => x.level === minLevel).length;
  const titleFirst = topCount === 1 && headings[0]?.level === minLevel;
  const base = titleFirst ? minLevel + 1 : minLevel;
  const counters: number[] = [];
  return headings.map((x, i) => {
    if ((titleFirst && i === 0) || x.level < base) return { ...x, number: "" };
    const depth = x.level - base;
    counters.length = depth + 1;
    for (let d = 0; d < depth; d++) counters[d] ??= 0;
    counters[depth] = (counters[depth] ?? 0) + 1;
    return { ...x, number: counters.map((n) => n ?? 0).join(".") };
  });
}

export class Toc {
  entries: TocEntry[] = [];
  private links: HTMLAnchorElement[] = [];
  private current = -2;

  constructor(
    private readonly list: HTMLOListElement,
    private readonly emptyNote: HTMLElement,
    private readonly onPick: (entry: TocEntry) => void,
  ) {}

  set(headings: Heading[]): void {
    const next = numberHeadings(headings);
    const same =
      next.length === this.entries.length &&
      next.every((e, i) => {
        const o = this.entries[i];
        return (
          o && o.id === e.id && o.text === e.text && o.number === e.number && o.level === e.level
        );
      });
    this.entries = next;
    if (same) return;
    this.links = next.map((entry) => {
      const a = h(
        "a",
        { href: `#${entry.id}`, "data-level": String(entry.level) },
        h("span", { class: "n" }, entry.number),
        h("span", { class: "t" }, entry.text),
      );
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.onPick(entry);
      });
      return a;
    });
    this.list.replaceChildren(...this.links.map((a) => h("li", {}, a)));
    this.emptyNote.hidden = next.length > 0;
    this.current = -2;
  }

  /** Marks the entry at `index` as the current section (-1 for none). */
  mark(index: number): void {
    if (index === this.current) return;
    this.links[this.current]?.removeAttribute("aria-current");
    this.current = index;
    const link = this.links[index];
    if (!link) return;
    link.setAttribute("aria-current", "location");
    const box = this.list.closest(".toc");
    if (box) {
      const top = link.offsetTop;
      if (top < box.scrollTop + 24 || top > box.scrollTop + box.clientHeight - 48) {
        box.scrollTop = top - box.clientHeight / 3;
      }
    }
  }

  /** Flags the entries whose sections hold marked changes. */
  markChanged(ids: Set<string>): void {
    this.entries.forEach((e, i) => {
      const link = this.links[i];
      if (!link) return;
      if (ids.has(e.id)) link.dataset.changed = "";
      else delete link.dataset.changed;
    });
  }

  entry(index: number): TocEntry | undefined {
    return this.entries[index];
  }
}
