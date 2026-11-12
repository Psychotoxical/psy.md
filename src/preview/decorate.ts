// Prepares freshly rendered blocks before they enter the document: wraps
// tables and code for sideways scrolling, adds copy buttons, replaces blocked
// images with an explanation, and marks diagrams and external links.
// Runs while the block is still detached, so nothing loads early.

import { t } from "../i18n";
import { h, icon } from "../ui/dom";
import { classifyHref } from "./links";

function all(root: Element, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)];
  return root.matches(selector) ? [root, ...found] : found;
}

function wrap(el: Element, className: string): HTMLElement {
  const w = h("div", { class: className });
  el.replaceWith(w);
  w.append(el);
  return w;
}

function blockedNote(src: string, alt: string): HTMLElement | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  const kind = url.host;
  const original = url.searchParams.get("src") ?? "";
  const dir = url.searchParams.get("dir");
  const note = h("span", { class: "media-note", title: alt || undefined });
  if (kind === "external") {
    let host = original;
    try {
      host = new URL(original).host;
    } catch {}
    note.append(
      h("span", {}, t("img.external", { host })),
      h("button", { type: "button", "data-action": "allow-external" }, t("img.externalAllow")),
    );
  } else if (kind === "local" && dir) {
    note.append(
      h("span", {}, t("img.local", { src: "" }), h("span", { class: "src" }, original)),
      h(
        "button",
        { type: "button", "data-action": "allow-folder", "data-dir": dir },
        t("img.localAllow", { dir }),
      ),
    );
  } else {
    note.append(
      h("span", {}, t("img.missing", { src: "" }), h("span", { class: "src" }, original)),
    );
  }
  return note;
}

export function decorate(block: Element): Element {
  let top = block;
  const replaceTop = (from: Element, to: Element) => {
    if (from === top) top = to;
  };

  for (const table of all(block, "table")) {
    replaceTop(table, wrap(table, "table-wrap"));
  }

  for (const pre of all(block, "pre")) {
    const code = pre.querySelector("code");
    const lang = /(?:^|\s)language-([\w+#.-]+)/.exec(code?.className ?? "")?.[1] ?? "";
    if (lang.toLowerCase() === "mermaid") {
      const source = code?.textContent ?? "";
      const fig = h(
        "figure",
        { class: "diagram", "data-state": "pending" },
        h("div", { class: "diagram-pending" }, t("mermaid.loading")),
        h("pre", { class: "diagram-source", hidden: true }, h("code", {}, source)),
      );
      pre.replaceWith(fig);
      replaceTop(pre, fig);
      continue;
    }
    if (lang) (pre as HTMLElement).dataset.lang = lang;
    const w = wrap(pre, "code-block");
    w.append(
      h(
        "button",
        {
          type: "button",
          class: "copy-btn",
          "data-action": "copy",
          "aria-label": t("code.copyLabel"),
        },
        icon("copy"),
        h("span", {}, t("code.copy")),
      ),
    );
    replaceTop(pre, w);
  }

  for (const img of all(block, "img")) {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith("psymd-blocked:")) {
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      continue;
    }
    const note = blockedNote(src, img.getAttribute("alt") ?? "");
    if (note) {
      img.replaceWith(note);
      replaceTop(img, note);
    } else {
      img.remove();
    }
  }

  for (const a of all(block, "a[href]")) {
    const target = classifyHref(a.getAttribute("href") ?? "");
    if (target.kind === "external") {
      a.setAttribute("data-external", "");
      if (!a.getAttribute("title")) a.setAttribute("title", target.url);
    } else if (target.kind === "blocked") {
      a.removeAttribute("href");
    }
  }
  return top;
}

/** Refreshes UI text inside decorated blocks after a language change. */
export function relabel(root: ParentNode): void {
  for (const b of root.querySelectorAll<HTMLElement>(".copy-btn")) {
    b.setAttribute("aria-label", t("code.copyLabel"));
    const label = b.querySelector("span");
    if (label && !b.dataset.done) label.textContent = t("code.copy");
  }
  for (const p of root.querySelectorAll<HTMLElement>(".diagram-pending")) {
    p.textContent = t("mermaid.loading");
  }
}
