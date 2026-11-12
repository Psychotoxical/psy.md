// Case-insensitive search that respects German orthography: case is folded,
// composed and decomposed forms are equal, but "ä" never matches "a".

interface Folded {
  text: string;
  /** For each UTF-16 unit of `text`: start of the source cluster. */
  starts: number[];
  /** For each UTF-16 unit of `text`: end of the source cluster. */
  ends: number[];
}

const MARK = /\p{M}/u;

function foldCluster(cluster: string): string {
  return cluster.normalize("NFC").toLowerCase();
}

/** Folds `text` cluster by cluster and remembers where each piece came from. */
export function fold(text: string): Folded {
  const starts: number[] = [];
  const ends: number[] = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = i;
    i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    while (i < text.length && MARK.test(String.fromCodePoint(text.codePointAt(i) ?? 0))) {
      i += (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    }
    const piece = foldCluster(text.slice(start, i));
    out += piece;
    for (let k = 0; k < piece.length; k++) {
      starts.push(start);
      ends.push(i);
    }
  }
  return { text: out, starts, ends };
}

export function foldQuery(query: string): string {
  return fold(query).text;
}

/** Non-overlapping matches as [start, end) ranges in `text`. */
export function findMatches(text: string, query: string): [number, number][] {
  const q = foldQuery(query);
  if (!q.trim()) return [];
  const f = fold(text);
  const out: [number, number][] = [];
  let from = 0;
  for (;;) {
    const at = f.text.indexOf(q, from);
    if (at < 0) break;
    const end = at + q.length - 1;
    out.push([f.starts[at] ?? 0, f.ends[end] ?? text.length]);
    from = at + q.length;
  }
  return out;
}
