// Decides what a click on a document link may do. Documents are untrusted:
// only in-page anchors, web and mail links, and relative files are handled.

export type LinkTarget =
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string }
  | { kind: "doc"; path: string; fragment: string | null }
  | { kind: "blocked" };

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function classifyHref(href: string): LinkTarget {
  const h = href.trim();
  if (!h || h.startsWith("//")) return { kind: "blocked" };
  if (h.startsWith("#")) return { kind: "anchor", id: decode(h.slice(1)) };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "mailto") {
    return { kind: "external", url: h };
  }
  if (scheme && scheme !== "file") return { kind: "blocked" };

  const hash = h.indexOf("#");
  const path = hash >= 0 ? h.slice(0, hash) : h;
  const fragment = hash >= 0 ? decode(h.slice(hash + 1)) || null : null;
  if (!path) return fragment ? { kind: "anchor", id: fragment } : { kind: "blocked" };
  return { kind: "doc", path, fragment };
}
