import { describe, expect, it } from "vitest";
import { summarizeChange } from "./change";

const base = ["# Plan", "", "## Goals", "", "a", "b", "", "## Risks", "", "c", "d", ""].join("\n");

describe("summarizeChange", () => {
  it("reports the changed line range in the new text and its section", () => {
    const next = base.replace("b", "B changed");
    expect(summarizeChange(base, next)).toEqual({ from: 6, to: 6, sections: ["Goals"] });
  });

  it("names every section the change touches", () => {
    const next = base.replace("b", "B").replace("c", "C");
    expect(summarizeChange(base, next)?.sections).toEqual(["Goals", "Risks"]);
  });

  it("handles insertions and deletions", () => {
    expect(summarizeChange(base, base.replace("a\n", "a\nnew line\n"))).toMatchObject({
      from: 6,
      to: 6,
    });
    const removed = summarizeChange(base, base.replace("a\nb\n", ""))!;
    expect(removed.from).toBe(5);
    expect(removed.to).toBe(4);
    expect(removed.sections).toEqual(["Goals"]);
  });

  it("returns null for identical text", () => {
    expect(summarizeChange(base, base)).toBeNull();
  });

  it("ignores heading markers inside fenced code", () => {
    const text = ["## Real", "```", "# not a heading", "x", "```", ""].join("\n");
    const next = text.replace("x", "y");
    expect(summarizeChange(text, next)?.sections).toEqual(["Real"]);
  });
});
