// Mermaid diagrams, loaded only when a document contains one. Diagrams run
// in Mermaid's strict mode and are shown as <img> with an SVG data URL, so a
// diagram can neither run script nor load anything. A broken diagram shows
// its error and source; the rest of the document is unaffected.

import { t } from "../i18n";
import { h } from "../ui/dom";

export const MAX_DIAGRAM_CHARS = 30_000;
export const MAX_DIAGRAMS = 50;

type Mermaid = typeof import("mermaid")["default"];

let loading: Promise<Mermaid> | null = null;
let configuredFor = "";
let counter = 0;
const cache = new Map<string, { svg: string; alt: string } | { error: string }>();

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  return loading;
}

export interface DiagramTheme {
  name: "mocha" | "latte";
  colors: Record<string, string>;
}

function configure(m: Mermaid, theme: DiagramTheme, font: string): void {
  const key = `${theme.name}|${font}`;
  if (configuredFor === key) return;
  const c = theme.colors;
  m.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    htmlLabels: false,
    layout: "dagre",
    look: "classic",
    theme: "base",
    fontFamily: font,
    themeVariables: {
      darkMode: theme.name === "mocha",
      background: c.base,
      fontFamily: font,
      fontSize: "14px",
      primaryColor: c.surface0,
      primaryTextColor: c.text,
      primaryBorderColor: c.blue,
      secondaryColor: c.mantle,
      secondaryTextColor: c.text,
      secondaryBorderColor: c.surface2,
      tertiaryColor: c.base,
      tertiaryTextColor: c.text,
      tertiaryBorderColor: c.surface1,
      lineColor: c.overlay2,
      textColor: c.text,
      mainBkg: c.surface0,
      nodeBorder: c.blue,
      clusterBkg: c.mantle,
      clusterBorder: c.surface1,
      titleColor: c.text,
      edgeLabelBackground: c.base,
      noteBkgColor: c.mantle,
      noteTextColor: c.text,
      noteBorderColor: c.surface2,
      actorBkg: c.surface0,
      actorBorder: c.blue,
      actorTextColor: c.text,
      actorLineColor: c.overlay1,
      signalColor: c.text,
      signalTextColor: c.text,
      labelBoxBkgColor: c.surface0,
      labelBoxBorderColor: c.surface2,
      labelTextColor: c.text,
      loopTextColor: c.text,
      activationBkgColor: c.surface1,
      activationBorderColor: c.overlay1,
      sequenceNumberColor: c.base,
    },
  });
  configuredFor = key;
}

/** Gives the SVG a fixed size so it scales correctly as an image. */
function sized(svg: string): string {
  const vb = /viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(svg);
  return svg.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
    let a = attrs.replace(/\swidth="[^"]*"/, "").replace(/\sheight="[^"]*"/, "");
    a = a.replace(/\sstyle="[^"]*"/, "");
    const size = vb
      ? ` width="${Math.ceil(Number(vb[1]))}" height="${Math.ceil(Number(vb[2]))}"`
      : "";
    return `<svg${a}${size}>`;
  });
}

function altFor(svg: string): string {
  const title = /<title[^>]*>([^<]{1,200})<\/title>/.exec(svg)?.[1];
  const desc = /<desc[^>]*>([^<]{1,300})<\/desc>/.exec(svg)?.[1];
  return [title, desc].filter(Boolean).join(". ") || t("mermaid.alt");
}

function sourceOf(fig: HTMLElement): string {
  return fig.querySelector(".diagram-source code")?.textContent ?? "";
}

function showError(fig: HTMLElement, message: string, detail?: string): void {
  const src = fig.querySelector<HTMLElement>(".diagram-source");
  const toggle = h(
    "button",
    {
      type: "button",
      class: "btn btn-quiet",
      "data-action": "toggle-source",
      "aria-expanded": "false",
    },
    t("mermaid.showSource"),
  );
  const note = h(
    "div",
    { class: "diagram-note", role: "note" },
    h("i", { class: "sq", "data-state": "error" }),
    h("span", { class: "msg" }, message),
    toggle,
    detail ? h("span", { class: "detail" }, detail) : null,
  );
  fig.replaceChildren(note);
  if (src) {
    src.hidden = true;
    fig.append(src);
  }
  fig.dataset.state = "error";
}

function showImage(fig: HTMLElement, svg: string, alt: string): void {
  const src = fig.querySelector(".diagram-source");
  const img = h("img", {
    alt,
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    decoding: "async",
  });
  fig.replaceChildren(img);
  if (src) fig.append(src);
  fig.dataset.state = "done";
}

export function toggleSource(btn: HTMLElement): void {
  const fig = btn.closest("figure.diagram");
  const src = fig?.querySelector<HTMLElement>(".diagram-source");
  if (!src) return;
  src.hidden = !src.hidden;
  btn.setAttribute("aria-expanded", String(!src.hidden));
  btn.textContent = src.hidden ? t("mermaid.showSource") : t("mermaid.hideSource");
}

/** Renders pending diagrams in document order. */
export async function renderDiagrams(
  root: ParentNode,
  theme: DiagramTheme,
  font: string,
  isCurrent: () => boolean,
): Promise<void> {
  const figs = [...root.querySelectorAll<HTMLElement>('figure.diagram[data-state="pending"]')];
  if (figs.length === 0) return;
  const all = [...root.querySelectorAll<HTMLElement>("figure.diagram")];
  const m = await load();
  configure(m, theme, font);
  const scratch = h("div", {
    style: "position:fixed;left:-20000px;top:0;width:1600px;visibility:hidden",
    "aria-hidden": "true",
  });
  document.body.append(scratch);
  try {
    for (const fig of figs) {
      if (!isCurrent() || !fig.isConnected) continue;
      const source = sourceOf(fig);
      if (all.indexOf(fig) >= MAX_DIAGRAMS) {
        showError(fig, t("mermaid.tooMany", { max: MAX_DIAGRAMS }));
        continue;
      }
      if (source.length > MAX_DIAGRAM_CHARS) {
        showError(fig, t("mermaid.tooLarge", { n: source.length, max: MAX_DIAGRAM_CHARS }));
        continue;
      }
      const key = `${configuredFor}\n${source}`;
      let result = cache.get(key);
      if (!result) {
        try {
          await m.parse(source);
          const { svg } = await m.render(`psymd-diagram-${++counter}`, source, scratch);
          result = { svg: sized(svg), alt: altFor(svg) };
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
        scratch.replaceChildren();
        if (cache.size > 200) cache.clear();
        cache.set(key, result);
      }
      if (!fig.isConnected) continue;
      if ("error" in result) showError(fig, t("mermaid.error"), result.error.slice(0, 600));
      else showImage(fig, result.svg, result.alt);
    }
  } finally {
    scratch.remove();
  }
}

/** Marks rendered diagrams for re-rendering, e.g. after a theme change. */
export function resetDiagrams(root: ParentNode): void {
  for (const fig of root.querySelectorAll<HTMLElement>("figure.diagram")) {
    const src = fig.querySelector(".diagram-source");
    fig.replaceChildren(h("div", { class: "diagram-pending" }, t("mermaid.loading")));
    if (src) fig.append(src);
    fig.dataset.state = "pending";
  }
}
