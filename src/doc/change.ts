// Describes where a newer version of a file differs from the one shown, so a
// conflict can say what changed on disk before the user decides.

export interface ChangeSummary {
  /** First changed line in the new text (1-based). */
  from: number;
  /** Last changed line in the new text; below `from` for a pure deletion. */
  to: number;
  /** Titles of the sections the change touches, in order. */
  sections: string[];
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

function headings(lines: string[]): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = FENCE.exec(l)?.[1];
    if (f) {
      if (!fence) fence = f[0] as string;
      else if (f[0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const m = ATX.exec(l);
    if (m?.[1]) out.push({ line: i + 1, text: m[1] });
  });
  return out;
}

export function summarizeChange(oldText: string, newText: string): ChangeSummary | null {
  if (oldText === newText) return null;
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const from = prefix + 1;
  const to = b.length - suffix;
  const hi = Math.max(from, to);
  const sections: string[] = [];
  let current: string | null = null;
  for (const h of headings(b)) {
    if (h.line <= from) current = h.text;
    else if (h.line <= hi) sections.push(h.text);
  }
  if (current !== null) sections.unshift(current);
  return { from, to, sections: [...new Set(sections)] };
}
