// Modal questions. Resolves with the id of the chosen button; Escape and
// closing the dialog resolve with `cancelId`.

import { byId, h } from "./dom";

export interface DialogButton {
  id: string;
  label: string;
  kind?: "primary" | "danger" | "default";
  /** Placed at the left edge, apart from the others. */
  apart?: boolean;
}

export function ask(opts: {
  title: string;
  body: string;
  buttons: DialogButton[];
  defaultId: string;
  cancelId: string;
}): Promise<string> {
  const dlg = byId<HTMLDialogElement>("dialog");
  return new Promise((resolve) => {
    let result = opts.cancelId;
    const actions = h("div", { class: "dialog-actions" });
    let first = true;
    for (const b of opts.buttons) {
      if (!b.apart && first && opts.buttons.some((x) => x.apart)) {
        actions.append(h("span", { class: "spacer" }));
      }
      if (!b.apart) first = false;
      const btn = h(
        "button",
        {
          type: "button",
          class: `btn${b.kind === "primary" ? " btn-primary" : b.kind === "danger" ? " btn-danger" : ""}`,
          "data-id": b.id,
        },
        b.label,
      );
      btn.addEventListener("click", () => {
        result = b.id;
        dlg.close();
      });
      if (b.apart) actions.prepend(btn);
      else actions.append(btn);
    }
    dlg.replaceChildren(
      h("h2", { id: "dialog-title" }, opts.title),
      h("p", { id: "dialog-body" }, opts.body),
      actions,
    );
    dlg.setAttribute("aria-describedby", "dialog-body");
    dlg.addEventListener(
      "close",
      () => {
        dlg.replaceChildren();
        resolve(result);
      },
      { once: true },
    );
    dlg.showModal();
    dlg.querySelector<HTMLButtonElement>(`[data-id="${opts.defaultId}"]`)?.focus();
  });
}

export function isDialogOpen(): boolean {
  return byId<HTMLDialogElement>("dialog").open || byId<HTMLDialogElement>("settings").open;
}
