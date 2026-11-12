// The adjustable divider between editor and preview.

export class Splitter {
  ratio = 0.5;

  constructor(
    private readonly el: HTMLElement,
    private readonly app: HTMLElement,
    private readonly onChange: (ratio: number) => void,
  ) {
    el.addEventListener("pointerdown", (ev) => this.drag(ev));
    el.addEventListener("keydown", (ev) => {
      const step = ev.shiftKey ? 0.1 : 0.02;
      const map: Record<string, number> = {
        ArrowLeft: this.ratio - step,
        ArrowUp: this.ratio - step,
        ArrowRight: this.ratio + step,
        ArrowDown: this.ratio + step,
        Home: 0.2,
        End: 0.8,
      };
      if (ev.key in map) {
        ev.preventDefault();
        this.set(map[ev.key] as number, true);
      }
    });
    el.addEventListener("dblclick", () => this.set(0.5, true));
  }

  private vertical(): boolean {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  set(ratio: number, notify = false): void {
    this.ratio = Math.min(0.8, Math.max(0.2, ratio));
    this.app.style.setProperty("--split", `${(this.ratio * 100).toFixed(2)}%`);
    this.el.setAttribute("aria-valuenow", String(Math.round(this.ratio * 100)));
    this.el.setAttribute("aria-orientation", this.vertical() ? "horizontal" : "vertical");
    if (notify) this.onChange(this.ratio);
  }

  private drag(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const main = this.el.parentElement;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    this.el.setPointerCapture(ev.pointerId);
    this.el.dataset.dragging = "";
    const move = (e: PointerEvent) => {
      const r = this.vertical()
        ? (e.clientY - rect.top) / rect.height
        : (e.clientX - rect.left) / rect.width;
      this.set(r);
    };
    const up = () => {
      this.el.removeEventListener("pointermove", move);
      this.el.removeEventListener("pointerup", up);
      this.el.removeEventListener("pointercancel", up);
      delete this.el.dataset.dragging;
      this.onChange(this.ratio);
    };
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
  }
}
