// Applies a new rendering to the preview while keeping unchanged blocks in
// place. Reused elements keep their state (highlighted code, rendered
// diagrams, loaded images), so updates do not flicker or jump, and only the
// blocks that really changed are reported.

export interface RenderedBlock {
  key: string;
  html: string;
  lineStart: number;
  lineEnd: number;
}

export interface ApplyStats {
  /** Indices (in the new list) of blocks that were created. */
  fresh: number[];
  /** Index range of `fresh`, or null when nothing was created. */
  changed: [number, number] | null;
  removed: number;
  /** New-list index of the first change or removal. */
  at: number;
}

/**
 * Index ranges for inserting a large document over several frames. Each
 * frame lays out the whole document so far, so the chunk doubles every
 * frame: the first screen appears quickly and the total layout work stays
 * proportional to the document instead of growing with the frame count.
 */
export function chunkPlan(total: number, first: number): [number, number][] {
  const out: [number, number][] = [];
  let size = first;
  for (let from = 0; from < total; from += size, size *= 2) {
    out.push([from, Math.min(from + size, total)]);
  }
  return out;
}

/** Largest middle section (old × new blocks) diffed exactly. */
const MAX_DIFF_CELLS = 400_000;

/**
 * For each new block, the index of the old block it reuses, or -1. Reused
 * indices are strictly increasing (a longest common subsequence of keys).
 */
export function diffKeys(prev: string[], next: string[]): number[] {
  const out = new Array<number>(next.length).fill(-1);
  const max = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < max && prev[prefix] === next[prefix]) {
    out[prefix] = prefix;
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < max - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    out[next.length - 1 - suffix] = prev.length - 1 - suffix;
    suffix++;
  }
  const a = prev.slice(prefix, prev.length - suffix);
  const b = next.slice(prefix, next.length - suffix);
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_DIFF_CELLS) return out;

  // LCS table over the middle section.
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j]
          ? (table[(i + 1) * w + j + 1] as number) + 1
          : Math.max(table[(i + 1) * w + j] as number, table[i * w + j + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out[prefix + j] = prefix + i;
      i++;
      j++;
    } else if ((table[(i + 1) * w + j] as number) >= (table[i * w + j + 1] as number)) i++;
    else j++;
  }
  return out;
}

const SOURCEPOS = /^(\d+):(\d+)-(\d+):(\d+)$/;

function shiftSourcepos(el: Element, delta: number): void {
  if (delta === 0) return;
  const nodes = [el, ...el.querySelectorAll("[data-sourcepos]")];
  for (const n of nodes) {
    const m = SOURCEPOS.exec(n.getAttribute("data-sourcepos") ?? "");
    if (!m) continue;
    n.setAttribute(
      "data-sourcepos",
      `${Number(m[1]) + delta}:${m[2]}-${Number(m[3]) + delta}:${m[4]}`,
    );
  }
}

/** One element per block; stray text or several elements get a wrapper. */
export function buildBlock(html: string): Element {
  const t = document.createElement("template");
  t.innerHTML = html;
  const nodes = [...t.content.childNodes].filter(
    (n) => n.nodeType === Node.ELEMENT_NODE || (n.textContent ?? "").trim() !== "",
  );
  if (nodes.length === 1 && nodes[0]?.nodeType === Node.ELEMENT_NODE) return nodes[0] as Element;
  const group = document.createElement("div");
  group.className = "block-group";
  group.append(...nodes);
  return group;
}

/**
 * Makes `root` show `next`, assuming it currently shows `prev` (one element
 * per block). New elements are built from a template and passed through
 * `prepare` before they are attached, so nothing in them loads early.
 */
export function applyBlocks(
  root: Element,
  prev: RenderedBlock[],
  next: RenderedBlock[],
  prepare: (el: Element) => Element = (el) => el,
): ApplyStats {
  const children = [...root.children];
  if (children.length !== prev.length) {
    // The DOM no longer matches what we rendered; start over.
    root.replaceChildren();
    return applyBlocks(root, [], next, prepare);
  }
  const map = diffKeys(
    prev.map((b) => b.key),
    next.map((b) => b.key),
  );

  const reused = new Set<number>();
  const fresh: number[] = [];
  const elements = map.map((oldIdx, i) => {
    const block = next[i] as RenderedBlock;
    if (oldIdx >= 0) {
      reused.add(oldIdx);
      const el = children[oldIdx] as Element;
      shiftSourcepos(el, block.lineStart - (prev[oldIdx] as RenderedBlock).lineStart);
      return el;
    }
    fresh.push(i);
    return prepare(buildBlock(block.html));
  });

  let removed = 0;
  let firstRemoved = -1;
  children.forEach((el, i) => {
    if (reused.has(i)) return;
    if (firstRemoved < 0) firstRemoved = i;
    el.remove();
    removed++;
  });
  elements.forEach((el, i) => {
    const current = root.children[i] ?? null;
    if (current !== el) root.insertBefore(el, current);
  });

  let at = fresh[0] ?? next.length;
  if (firstRemoved >= 0) {
    // Position in the new list where the first removed block used to be.
    const before = map.filter((o) => o >= 0 && o < firstRemoved).length;
    at = Math.min(at, before);
  }
  return {
    fresh,
    changed: fresh.length ? [fresh[0] as number, fresh[fresh.length - 1] as number] : null,
    removed,
    at,
  };
}
