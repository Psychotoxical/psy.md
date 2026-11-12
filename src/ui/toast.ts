// Short notices above the footer line. Information fades after a while;
// errors stay until they are dismissed or replaced.

import { t } from "../i18n";
import { byId, h } from "./dom";

let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string, state: "error" | "info" = "info"): void {
  const el = byId("toast");
  const close = h("button", {
    type: "button",
    class: "icon-btn toast-close",
    "aria-label": t("toast.close"),
    title: t("toast.close"),
  });
  close.innerHTML =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
  close.addEventListener("click", hideToast);
  el.replaceChildren(
    h("i", { class: "sq", "data-state": state === "error" ? "error" : "current" }),
    h("span", {}, text),
    close,
  );
  el.setAttribute("role", state === "error" ? "alert" : "status");
  el.hidden = false;
  clearTimeout(timer);
  if (state === "info") {
    timer = setTimeout(() => {
      el.hidden = true;
    }, 6000);
  }
}

export function hideToast(): void {
  clearTimeout(timer);
  byId("toast").hidden = true;
}

export function isToastOpen(): boolean {
  return !byId("toast").hidden;
}
