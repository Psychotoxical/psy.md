// Find in the rendered document: marks matches in place and steps through
// them. Matching follows ./fold (case-insensitive, umlaut-aware).

import { findMatches } from "./fold";

const MAX_HITS = 5000;
const SKIP = ".copy-btn, button, [hidden], .rev-layer";

export class PreviewSearch {
  private hits: HTMLElement[][] = [];
  private index = -1;
  query = "";

  constructor(private readonly root: HTMLElement) {}

  get total(): number {
    return this.hits.length;
  }

  get position(): number {
    return this.index + 1;
  }

  clear(): void {
    const parents = new Set<Node>();
    for (const spans of this.hits) {
      for (const s of spans) {
        const parent = s.parentNode;
        if (!parent) continue;
        s.replaceWith(...s.childNodes);
        parents.add(parent);
      }
    }
    for (const p of parents) p.normalize();
    this.hits = [];
    this.index = -1;
  }

  /** Runs `query`; keeps the current position near `keepNear` if given. */
  run(query: string, keepNear = -1): void {
    this.clear();
    this.query = query;
    if (!query.trim()) return;

    const nodes: Text[] = [];
    const starts: number[] = [];
    let all = "";
    const walker = document.createTreeWalker(this.root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n as Text);
      starts.push(all.length);
      all += (n as Text).data;
    }
    const matches = findMatches(all, query).slice(0, MAX_HITS);
    if (matches.length === 0) return;

    // Ranges per text node, then split each node from its end backwards.
    const perNode = new Map<number, { s: number; e: number; m: number }[]>();
    let ni = 0;
    matches.forEach(([ms, me], m) => {
      while (ni < nodes.length - 1 && (starts[ni + 1] ?? 0) <= ms) ni++;
      for (let k = ni; k < nodes.length; k++) {
        const ns = starts[k] ?? 0;
        const ne = ns + (nodes[k]?.data.length ?? 0);
        if (ns >= me) break;
        const s = Math.max(ms, ns) - ns;
        const e = Math.min(me, ne) - ns;
        if (e > s) {
          const list = perNode.get(k) ?? [];
          list.push({ s, e, m });
          perNode.set(k, list);
        }
      }
    });
    this.hits = matches.map(() => []);
    for (const [k, ranges] of perNode) {
      const node = nodes[k] as Text;
      for (let r = ranges.length - 1; r >= 0; r--) {
        const { s, e, m } = ranges[r] as { s: number; e: number; m: number };
        node.splitText(e);
        const mid = node.splitText(s);
        const span = document.createElement("span");
        span.className = "find-hit";
        mid.replaceWith(span);
        span.append(mid);
        this.hits[m]?.unshift(span);
      }
    }
    // Spans of one match were collected node by node; restore document order.
    for (const spans of this.hits) {
      spans.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
    }
    this.select(keepNear >= 0 ? Math.min(keepNear, this.hits.length - 1) : 0, keepNear < 0);
  }

  private select(i: number, scroll: boolean): void {
    for (const s of this.hits[this.index] ?? []) delete s.dataset.current;
    this.index = i;
    const spans = this.hits[i] ?? [];
    for (const s of spans) s.dataset.current = "";
    if (scroll) spans[0]?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  next(): void {
    if (this.hits.length) this.select((this.index + 1) % this.hits.length, true);
  }

  previous(): void {
    if (this.hits.length) this.select((this.index - 1 + this.hits.length) % this.hits.length, true);
  }
}
