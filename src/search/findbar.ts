// The find bar. It searches the editor when the source has focus (or is the
// only view) and the rendered document otherwise.

import type { Editor } from "../editor/editor";
import { t } from "../i18n";
import type { PreviewSearch } from "./preview-search";

export type FindTarget = "editor" | "preview";

export class FindBar {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private target: FindTarget = "preview";
  private returnFocus: HTMLElement | null = null;

  constructor(
    private readonly box: HTMLElement,
    private readonly input: HTMLInputElement,
    private readonly out: HTMLOutputElement,
    private readonly preview: PreviewSearch,
    private readonly editor: () => Editor | null,
    private readonly chooseTarget: () => FindTarget,
  ) {
    input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), 70);
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        clearTimeout(this.timer);
        if (this.currentQuery() !== this.input.value) this.run();
        else if (ev.shiftKey) this.previous();
        else this.next();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.box.hidden;
  }

  open(prefill?: string): void {
    const target = this.chooseTarget();
    if (this.isOpen && target !== this.target) this.clearTarget();
    this.target = target;
    if (!this.isOpen) {
      this.returnFocus = document.activeElement as HTMLElement | null;
    }
    this.box.hidden = false;
    document.getElementById("app")?.setAttribute("data-finding", "");
    if (prefill && !prefill.includes("\n")) this.input.value = prefill;
    this.input.focus();
    this.input.select();
    this.run();
  }

  close(): void {
    if (!this.isOpen) return;
    clearTimeout(this.timer);
    this.clearTarget();
    this.box.hidden = true;
    document.getElementById("app")?.removeAttribute("data-finding");
    this.out.textContent = "";
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    else if (this.target === "editor") this.editor()?.focus();
  }

  private clearTarget(): void {
    if (this.target === "editor") this.editor()?.clearQuery();
    else this.preview.clear();
  }

  private currentQuery(): string {
    return this.target === "editor" ? this.input.value : this.preview.query;
  }

  private run(): void {
    const q = this.input.value;
    if (this.target === "editor") {
      const ed = this.editor();
      if (!ed) return;
      if (q) {
        ed.setQuery(q);
        ed.next();
      } else ed.clearQuery();
    } else {
      this.preview.run(q);
    }
    this.report();
  }

  /** Re-applies the query after the document was re-rendered. */
  refresh(): void {
    if (!this.isOpen || this.target !== "preview") return;
    const keep = this.preview.position - 1;
    this.preview.run(this.input.value, Math.max(0, keep));
    this.report();
  }

  /** Called before the preview DOM is replaced. */
  suspend(): void {
    if (this.isOpen && this.target === "preview") this.preview.clear();
  }

  next(): void {
    if (this.target === "editor") this.editor()?.next();
    else this.preview.next();
    this.report();
  }

  previous(): void {
    if (this.target === "editor") this.editor()?.previous();
    else this.preview.previous();
    this.report();
  }

  report(): void {
    const q = this.input.value;
    let index = 0;
    let total = 0;
    if (this.target === "editor") {
      const c = this.editor()?.count() ?? { index: 0, total: 0 };
      index = c.index;
      total = c.total;
    } else {
      index = this.preview.position;
      total = this.preview.total;
    }
    if (!q) {
      this.out.textContent = "";
      delete this.out.dataset.none;
    } else if (total === 0) {
      this.out.textContent = t("find.none");
      this.out.dataset.none = "";
    } else {
      this.out.textContent = t("find.count", { i: index || "–", n: total });
      delete this.out.dataset.none;
    }
  }
}
