// Settings dialog. Every change applies immediately and is saved.

import { type Key, t } from "../i18n";
import type { Settings } from "../settings";
import { byId, h } from "./dom";

export interface SettingsContext {
  get(): Settings;
  apply(patch: Partial<Settings>): void;
  zoomBy(steps: number): void;
  zoomReset(): void;
  recentCount(): number;
  clearRecent(): void;
}

function radioGroup<T extends string>(
  name: string,
  legend: Key,
  value: T,
  options: [T, Key][],
  onPick: (v: T) => void,
): HTMLFieldSetElement {
  const group = h("div", { class: "segmented" });
  for (const [v, label] of options) {
    const input = h("input", {
      type: "radio",
      name,
      value: v,
      checked: v === value,
      id: `set-${name}-${v}`,
    });
    input.addEventListener("change", () => input.checked && onPick(v));
    group.append(h("label", {}, input, t(label)));
  }
  return h("fieldset", {}, h("legend", {}, t(legend)), group);
}

export function openSettings(ctx: SettingsContext): void {
  const dlg = byId<HTMLDialogElement>("settings");

  const render = (focusId?: string) => {
    const s = ctx.get();
    const lang = h(
      "select",
      { id: "set-language", "aria-labelledby": "set-language-label" },
      h("option", { value: "en", selected: s.language === "en" }, "English"),
      h("option", { value: "de", selected: s.language === "de" }, "Deutsch"),
    );
    lang.addEventListener("change", () => {
      ctx.apply({ language: lang.value === "de" ? "de" : "en" });
      render("set-language");
    });

    const zoomOut = h(
      "button",
      { type: "button", class: "btn", id: "set-zoom-out", "aria-label": t("menu.zoomOut") },
      "−",
    );
    const zoomIn = h(
      "button",
      { type: "button", class: "btn", id: "set-zoom-in", "aria-label": t("menu.zoomIn") },
      "+",
    );
    const zoomReset = h(
      "button",
      { type: "button", class: "btn btn-quiet", id: "set-zoom-reset" },
      t("menu.zoomReset"),
    );
    const zoomOut2 = h(
      "output",
      { id: "set-zoom-value", "aria-live": "polite" },
      `${Math.round(s.zoom * 100)} %`,
    );
    zoomOut.addEventListener("click", () => {
      ctx.zoomBy(-1);
      render("set-zoom-out");
    });
    zoomIn.addEventListener("click", () => {
      ctx.zoomBy(1);
      render("set-zoom-in");
    });
    zoomReset.addEventListener("click", () => {
      ctx.zoomReset();
      render("set-zoom-reset");
    });

    const marks = h("input", { type: "checkbox", id: "set-marks", checked: s.marks });
    marks.addEventListener("change", () => ctx.apply({ marks: marks.checked }));

    const count = ctx.recentCount();
    const clear = h(
      "button",
      { type: "button", class: "btn", id: "set-clear-recent", disabled: count === 0 },
      t("settings.clearRecent"),
    );
    const recentNote = h("span", { "aria-live": "polite" });
    clear.addEventListener("click", () => {
      ctx.clearRecent();
      clear.disabled = true;
      recentNote.textContent = t("settings.recentCleared");
    });

    const close = h(
      "button",
      { type: "button", class: "btn btn-primary", id: "set-close" },
      t("settings.close"),
    );
    close.addEventListener("click", () => dlg.close());

    const form = h(
      "form",
      { method: "dialog" },
      radioGroup(
        "theme",
        "settings.theme",
        s.theme,
        [
          ["system", "settings.theme.system"],
          ["mocha", "settings.theme.mocha"],
          ["latte", "settings.theme.latte"],
        ],
        (theme) => ctx.apply({ theme }),
      ),
      h(
        "div",
        { class: "field" },
        h(
          "label",
          { class: "field-label", id: "set-language-label", for: "set-language" },
          t("settings.language"),
        ),
        h("div", {}, lang),
      ),
      radioGroup(
        "font",
        "settings.font",
        s.font,
        [
          ["system", "settings.font.system"],
          ["inter", "settings.font.inter"],
        ],
        (font) => ctx.apply({ font }),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, t("settings.zoom")),
        h("div", { class: "zoom-row" }, zoomOut, zoomOut2, zoomIn, zoomReset),
      ),
      h("label", { class: "check-row", for: "set-marks" }, marks, t("settings.marks")),
      h(
        "fieldset",
        {},
        h("legend", {}, t("settings.recent")),
        h("div", { class: "recent-row" }, clear, recentNote),
      ),
      h("div", { class: "dialog-actions" }, close),
    );
    form.addEventListener("submit", (ev) => ev.preventDefault());
    dlg.replaceChildren(h("h2", { id: "settings-title" }, t("settings.title")), form);
    // showModal() moves focus itself, so focus is set afterwards.
    if (!dlg.open) dlg.showModal();
    const focus = focusId ? dlg.querySelector<HTMLElement>(`#${focusId}`) : null;
    (focus ?? dlg.querySelector<HTMLElement>("input:checked"))?.focus();
  };

  render();
}
