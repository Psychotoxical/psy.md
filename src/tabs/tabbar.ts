// The row of open files above the header line.

import { t } from "../i18n";
import { h } from "../ui/dom";

export type TabState = "current" | "changed" | "unsaved" | "conflict" | "missing" | "error";

export interface TabView {
  name: string;
  path: string;
  state: TabState;
  active: boolean;
}

export interface TabBarHooks {
  select(index: number): void;
  close(index: number): void;
  menu(index: number, anchor: HTMLElement): void;
  add(): void;
}

const STATE_WORD: Record<Exclude<TabState, "current">, () => string> = {
  changed: () => t("tabs.changed"),
  unsaved: () => t("status.unsaved"),
  conflict: () => t("status.conflict"),
  missing: () => t("status.missing"),
  error: () => t("status.error"),
};

function closeIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4.5 4.5l7 7M11.5 4.5l-7 7");
  svg.append(path);
  return svg;
}

export class TabBar {
  private readonly list: HTMLElement;
  private readonly addBtn: HTMLButtonElement;
  private count = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: TabBarHooks,
  ) {
    this.list = h("div", { class: "tab-list", role: "tablist" });
    this.addBtn = h("button", { type: "button", class: "tab-add icon-btn" });
    const plus = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    plus.setAttribute("viewBox", "0 0 16 16");
    plus.setAttribute("class", "icon");
    plus.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M8 3.5v9M3.5 8h9");
    plus.append(p);
    this.addBtn.append(plus);
    this.addBtn.addEventListener("click", () => hooks.add());
    root.replaceChildren(this.list, this.addBtn);

    this.list.addEventListener("keydown", (e) => this.onKey(e));
    // A mouse wheel scrolls the row sideways when it overflows.
    this.list.addEventListener(
      "wheel",
      (e) => {
        if (e.ctrlKey || e.metaKey || this.list.scrollWidth <= this.list.clientWidth) return;
        this.list.scrollLeft += e.deltaY || e.deltaX;
        e.preventDefault();
      },
      { passive: false },
    );
  }

  render(views: TabView[]): void {
    this.count = views.length;
    this.root.setAttribute("aria-label", t("tabs.label"));
    this.list.setAttribute("aria-label", t("tabs.label"));
    this.addBtn.setAttribute("aria-label", t("tabs.open"));
    this.addBtn.title = t("tabs.open");
    const focusWasInside = this.list.contains(document.activeElement);
    this.list.replaceChildren(...views.map((v, i) => this.tab(v, i)));
    const active = this.list.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (focusWasInside) active?.focus();
  }

  private tab(v: TabView, i: number): HTMLElement {
    const word = v.state === "current" ? "" : STATE_WORD[v.state]();
    const close = h("button", {
      type: "button",
      class: "tab-close",
      tabindex: "-1",
      "aria-label": t("tabs.closeNamed", { name: v.name }),
      title: t("tabs.close"),
    });
    close.append(closeIcon());
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hooks.close(i);
    });
    const el = h(
      "div",
      {
        class: "tab",
        role: "tab",
        tabindex: v.active ? "0" : "-1",
        "aria-selected": v.active ? "true" : "false",
        "aria-label": word ? `${v.name}, ${word}` : v.name,
        title: word ? `${v.path}\n${word}` : v.path,
        "data-state": v.state,
      },
      v.state === "current" ? null : h("i", { class: "sq", "data-state": v.state }),
      h("span", { class: "tab-name" }, v.name),
      close,
    );
    el.addEventListener("click", () => this.hooks.select(i));
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.hooks.close(i);
      }
    });
    // Middle-click must not start autoscroll.
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.hooks.menu(i, el);
    });
    return el;
  }

  private onKey(e: KeyboardEvent): void {
    const tabs = [...this.list.querySelectorAll<HTMLElement>('[role="tab"]')];
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let to = -1;
    if (e.key === "ArrowRight") to = (at + 1) % this.count;
    else if (e.key === "ArrowLeft") to = (at - 1 + this.count) % this.count;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = this.count - 1;
    else if (e.key === "Delete") {
      e.preventDefault();
      this.hooks.close(at);
      return;
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const el = tabs[at];
      if (el) this.hooks.menu(at, el);
      return;
    }
    if (to < 0) return;
    e.preventDefault();
    this.hooks.select(to);
    tabs[to]?.focus();
  }
}
