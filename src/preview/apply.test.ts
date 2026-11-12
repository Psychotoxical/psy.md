import { describe, expect, it } from "vitest";
import { applyBlocks, chunkPlan, diffKeys } from "./apply";

describe("chunkPlan", () => {
  it("doubles the chunk each frame so a large document needs few layouts", () => {
    expect(chunkPlan(5000, 400)).toEqual([
      [0, 400],
      [400, 1200],
      [1200, 2800],
      [2800, 5000],
    ]);
  });

  it("uses one chunk when everything fits into the first", () => {
    expect(chunkPlan(300, 400)).toEqual([[0, 300]]);
    expect(chunkPlan(0, 400)).toEqual([]);
  });

  it("needs about log2 frames for fifty thousand blocks", () => {
    expect(chunkPlan(48_470, 400)).toHaveLength(7);
  });
});

describe("diffKeys", () => {
  it("reuses unchanged blocks around one change", () => {
    expect(diffKeys(["a", "b", "c", "d"], ["a", "x", "c", "d"])).toEqual([0, -1, 2, 3]);
  });
  it("handles insertions", () => {
    expect(diffKeys(["a", "b"], ["a", "n", "b"])).toEqual([0, -1, 1]);
  });
  it("handles identical lists", () => {
    expect(diffKeys(["a", "b"], ["a", "b"])).toEqual([0, 1]);
  });
  it("keeps unchanged blocks between two separate changes", () => {
    expect(diffKeys(["a", "b", "c", "d", "e"], ["a", "X", "c", "d", "Y"])).toEqual([
      0, -1, 2, 3, -1,
    ]);
  });
  it("matches duplicates in order only", () => {
    expect(diffKeys(["a", "a"], ["a"])).toEqual([0]);
    expect(diffKeys(["a"], ["a", "a"])).toEqual([0, -1]);
    expect(diffKeys(["a", "b"], ["b", "a"]).filter((i) => i >= 0).length).toBe(1);
  });
});

const block = (key: string, line: number, text: string) => ({
  key,
  lineStart: line,
  lineEnd: line,
  html: `<p data-sourcepos="${line}:1-${line}:4">${text}</p>`,
});

describe("applyBlocks", () => {
  it("keeps reused elements and shifts their source positions", () => {
    const root = document.createElement("div");
    const first = [block("a", 1, "eins"), block("b", 3, "zwei")];
    applyBlocks(root, [], first);
    const kept = root.children[1];
    const next = [block("n", 1, "neu"), block("a", 3, "eins"), block("b", 5, "zwei")];
    const stats = applyBlocks(root, first, next);
    expect(root.children.length).toBe(3);
    expect(root.children[2]).toBe(kept);
    expect(kept?.getAttribute("data-sourcepos")).toBe("5:1-5:4");
    expect(stats.fresh).toEqual([0]);
    expect(root.textContent).toBe("neueinszwei");
  });

  it("removes blocks that disappeared and reports where", () => {
    const root = document.createElement("div");
    const first = [block("a", 1, "eins"), block("b", 3, "zwei"), block("c", 5, "drei")];
    applyBlocks(root, [], first);
    const stats = applyBlocks(root, first, [block("a", 1, "eins"), block("c", 3, "drei")]);
    expect(root.textContent).toBe("einsdrei");
    expect(stats.fresh).toEqual([]);
    expect(stats.removed).toBe(1);
    expect(stats.at).toBe(1);
  });

  it("replaces only the changed blocks of two separate edits", () => {
    const root = document.createElement("div");
    const first = ["a", "b", "c", "d", "e"].map((k, i) => block(k, i * 2 + 1, k));
    applyBlocks(root, [], first);
    const middle = root.children[2];
    const next = [
      block("a", 1, "a"),
      block("X", 3, "X"),
      block("c", 5, "c"),
      block("d", 7, "d"),
      block("Y", 9, "Y"),
    ];
    const stats = applyBlocks(root, first, next);
    expect(stats.fresh).toEqual([1, 4]);
    expect(root.children[2]).toBe(middle);
    expect(root.textContent).toBe("aXcdY");
  });
});
