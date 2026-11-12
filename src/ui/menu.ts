// Popup menus with keyboard support (arrows, Home/End, Enter, Escape).

import { byId, h, icon } from "./dom";

export type MenuEntry =
  | {
      label: string;
      sub?: string;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      action: () => void;
    }
  | { group: string }
  | "separator";

let openState: { anchor: HTMLElement; cleanup: () => void } | null = null;

export function closeMenu(returnFocus = true): void {
  if (!openState) return;
  const { anchor, cleanup } = openState;
  openState = null;
  cleanup();
  if (returnFocus) anchor.focus();
}

export function isMenuOpen(): boolean {
  return openState !== null;
}

export function openMenu(anchor: HTMLElement, entries: MenuEntry[]): void {
  closeMenu(false);
  const menu = byId("menu");
  menu.replaceChildren();
  const items: HTMLButtonElement[] = [];

  for (const e of entries) {
    if (e === "separator") {
      menu.append(h("hr", { role: "separator" }));
      continue;
    }
    if ("group" in e) {
      menu.append(h("div", { class: "group", role: "presentation" }, e.group));
      continue;
    }
    const role = e.checked === undefined ? "menuitem" : "menuitemcheckbox";
    const btn = h(
      "button",
      {
        type: "button",
        role,
        tabindex: "-1",
        "aria-disabled": e.disabled ? "true" : undefined,
        "aria-checked": e.checked === undefined ? undefined : String(e.checked),
      },
      e.checked ? icon("check") : h("span"),
      h("span", { class: "label" }, e.label, e.sub ? h("span", { class: "sub" }, e.sub) : null),
      e.shortcut ? h("kbd", {}, e.shortcut) : h("span"),
    );
    btn.addEventListener("click", () => {
      if (e.disabled) return;
      closeMenu();
      e.action();
    });
    items.push(btn);
    menu.append(btn);
  }

  menu.hidden = false;
  anchor.setAttribute("aria-expanded", "true");
  position(menu, anchor);

  const focusAt = (i: number) => {
    const enabled = items.filter((b) => b.getAttribute("aria-disabled") !== "true");
    if (enabled.length === 0) return;
    const idx = (i + enabled.length) % enabled.length;
    enabled[idx]?.focus();
  };
  const current = () =>
    items
      .filter((b) => b.getAttribute("aria-disabled") !== "true")
      .indexOf(document.activeElement as HTMLButtonElement);

  const onKey = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        focusAt(current() + 1);
        break;
      case "ArrowUp":
        ev.preventDefault();
        focusAt(current() - 1);
        break;
      case "Home":
        ev.preventDefault();
        focusAt(0);
        break;
      case "End":
        ev.preventDefault();
        focusAt(-1);
        break;
      case "Escape":
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu();
        break;
      case "Tab":
        closeMenu(false);
        break;
    }
  };
  const onDown = (ev: PointerEvent) => {
    const t = ev.target as Node;
    if (!menu.contains(t) && !anchor.contains(t)) closeMenu(false);
  };
  const onResize = () => closeMenu(false);
  menu.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("resize", onResize);

  openState = {
    anchor,
    cleanup: () => {
      menu.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onResize);
      menu.hidden = true;
      menu.replaceChildren();
      anchor.setAttribute("aria-expanded", "false");
    },
  };
  focusAt(0);
}

function position(menu: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
}
