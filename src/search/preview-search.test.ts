import { describe, expect, it } from "vitest";
import { PreviewSearch } from "./preview-search";

describe("PreviewSearch", () => {
  it("marks matches across element boundaries and restores the text", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Grüße an <b>Gr</b>üße und GRÜSSE</p><p>Ende grüße</p>";
    const before = root.innerHTML;
    const s = new PreviewSearch(root);
    s.run("grüße");
    expect(s.total).toBe(3);
    expect(root.querySelectorAll(".find-hit").length).toBe(4);
    expect(s.position).toBe(1);
    s.next();
    expect(s.position).toBe(2);
    s.previous();
    s.previous();
    expect(s.position).toBe(3);
    s.clear();
    expect(root.innerHTML).toBe(before);
  });

  it("ignores button labels and hidden text", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Kopieren</p><button>Kopieren</button><pre hidden>Kopieren</pre>";
    const s = new PreviewSearch(root);
    s.run("kopieren");
    expect(s.total).toBe(1);
  });
});
