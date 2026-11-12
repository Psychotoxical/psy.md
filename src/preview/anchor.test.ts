import { describe, expect, it } from "vitest";
import { captureAnchor, resolveAnchor } from "./anchor";

const box = (key: string, top: number, height = 100, line = 1) => ({ key, top, height, line });

describe("reading anchor", () => {
  it("restores the same block after content is inserted above", () => {
    const anchor = captureAnchor([box("A", 0), box("B", 100), box("C", 200)], 150);
    expect(anchor?.key).toBe("B");
    const top = resolveAnchor(anchor!, [
      box("N", 0, 300),
      box("A", 300),
      box("B", 400),
      box("C", 500),
    ]);
    expect(top).toBe(450);
  });

  it("falls back to the following block when the anchored one was deleted", () => {
    const anchor = captureAnchor([box("A", 0), box("B", 100), box("C", 200)], 150)!;
    expect(resolveAnchor(anchor, [box("A", 0), box("C", 100)])).toBe(100);
  });

  it("falls back to the source line when nothing matches", () => {
    const anchor = captureAnchor(
      [box("A", 0, 100, 1), box("B", 100, 100, 10), box("C", 200, 100, 20)],
      120,
    )!;
    const top = resolveAnchor(anchor, [
      box("X", 0, 50, 1),
      box("Y", 50, 50, 9),
      box("Z", 100, 50, 30),
    ]);
    expect(top).toBe(50);
  });

  it("chooses the nearest duplicate", () => {
    const anchor = captureAnchor([box("D", 0), box("x", 100), box("D", 200)], 210)!;
    expect(resolveAnchor(anchor, [box("D", 0), box("x", 100), box("y", 200), box("D", 300)])).toBe(
      310,
    );
  });

  it("returns null above the first block and clamps offsets to the block", () => {
    expect(captureAnchor([], 0)).toBeNull();
    const anchor = captureAnchor([box("A", 0, 400)], 350)!;
    expect(resolveAnchor(anchor, [box("A", 0, 100)])).toBe(100);
  });
});
