import { describe, expect, it } from "vitest";
import { activeAfterClose, ClosedTabs, findTab, toClose } from "./tabs";

describe("findTab", () => {
  it("finds an open file however its path is spelled on Windows", () => {
    expect(findTab(["C:\\Docs\\a.md", "C:\\Docs\\b.md"], "c:/docs/B.md")).toBe(1);
  });

  it("tells files apart that differ only in case elsewhere", () => {
    expect(findTab(["/home/x/A.md"], "/home/x/a.md")).toBe(-1);
  });
});

describe("activeAfterClose", () => {
  it("moves to the right neighbour when the active tab closes", () => {
    expect(activeAfterClose(4, 1, 1)).toBe(1);
  });

  it("moves to the left neighbour when the last tab closes", () => {
    expect(activeAfterClose(3, 2, 2)).toBe(1);
  });

  it("keeps the same tab active when another one closes", () => {
    expect(activeAfterClose(4, 0, 2)).toBe(1);
    expect(activeAfterClose(4, 3, 2)).toBe(2);
  });

  it("leaves nothing active when the only tab closes", () => {
    expect(activeAfterClose(1, 0, 0)).toBe(-1);
  });
});

describe("toClose", () => {
  it("closes all others", () => {
    expect(toClose("others", 4, 1)).toEqual([0, 2, 3]);
  });

  it("closes the tabs to the right", () => {
    expect(toClose("right", 4, 1)).toEqual([2, 3]);
    expect(toClose("right", 4, 3)).toEqual([]);
  });

  it("closes all", () => {
    expect(toClose("all", 3, 1)).toEqual([0, 1, 2]);
  });
});

describe("ClosedTabs", () => {
  it("reopens the most recently closed tab first", () => {
    const c = new ClosedTabs();
    c.push("a.md");
    c.push("b.md");
    expect(c.pop()).toBe("b.md");
    expect(c.pop()).toBe("a.md");
    expect(c.pop()).toBeNull();
  });

  it("keeps a limited history", () => {
    const c = new ClosedTabs(2);
    for (const p of ["a.md", "b.md", "c.md"]) c.push(p);
    expect(c.pop()).toBe("c.md");
    expect(c.pop()).toBe("b.md");
    expect(c.pop()).toBeNull();
  });

  it("tells whether anything can be reopened", () => {
    const c = new ClosedTabs();
    expect(c.has()).toBe(false);
    c.push("a.md");
    expect(c.has()).toBe(true);
  });

  it("forgets a file once it is open again", () => {
    const c = new ClosedTabs();
    c.push("a.md");
    c.push("b.md");
    c.forget("a.md");
    expect(c.pop()).toBe("b.md");
    expect(c.pop()).toBeNull();
  });
});
