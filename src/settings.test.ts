import { describe, expect, it } from "vitest";
import { addRecent, clampZoom, readSession, readSettings } from "./settings";

describe("settings", () => {
  it("falls back to defaults for invalid stored values", () => {
    const s = readSettings({ theme: "neon", language: "fr", zoom: "x", font: 3 });
    expect(s).toEqual({ theme: "system", language: "en", font: "system", zoom: 1, marks: true });
  });

  it("clamps zoom between 50 and 250 percent", () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(9)).toBe(2.5);
    expect(clampZoom(1.1000000001)).toBe(1.1);
    expect(readSettings({ zoom: 7 }).zoom).toBe(2.5);
  });

  it("restores a valid session and drops junk", () => {
    const s = readSession({ lastFile: "/a.md", view: "split", split: 2, recent: ["/a.md", 4] });
    expect(s.view).toBe("split");
    expect(s.split).toBe(0.8);
    expect(s.recent).toEqual(["/a.md"]);
  });

  it("treats Windows paths that differ only in slashes or case as the same file", () => {
    const r = addRecent(["D:/Notes/Plan.md", "/home/a/x.md"], "d:\\notes\\plan.md");
    expect(r).toEqual(["d:\\notes\\plan.md", "/home/a/x.md"]);
    expect(addRecent(["/home/a/X.md"], "/home/a/x.md")).toEqual(["/home/a/x.md", "/home/a/X.md"]);
    expect(readSession({ recent: ["D:/a.md", "D:\\a.md", "e:\\b.md"] }).recent).toEqual([
      "D:/a.md",
      "e:\\b.md",
    ]);
  });

  it("keeps the recent list unique, newest first, at most ten", () => {
    let r: string[] = [];
    for (let i = 0; i < 12; i++) r = addRecent(r, `/f${i}.md`);
    r = addRecent(r, "/f5.md");
    expect(r[0]).toBe("/f5.md");
    expect(r.length).toBe(10);
    expect(new Set(r).size).toBe(10);
  });
});
