import { describe, expect, it } from "vitest";
import { type DiskVersion, type DocState, isDirty, openDoc, reduce } from "./model";

const version = (text: string, token = `t-${text}`): DiskVersion => ({
  text,
  token,
  bom: false,
  eol: "lf",
  mixedEol: false,
});

const opened = (text = "eins"): DocState =>
  openDoc({ sessionId: 1, path: "/d/a.md", name: "a.md", dir: "/d" }, version(text));

describe("document model", () => {
  it("reloads an external change when there are no local edits", () => {
    const s = reduce(opened(), { type: "external", seq: 1, version: version("zwei"), at: 5 });
    expect(s.buffer).toBe("zwei");
    expect(s.base.token).toBe("t-zwei");
    expect(s.disk).toBe("current");
    expect(s.lastExternalAt).toBe(5);
    expect(isDirty(s)).toBe(false);
  });

  it("opens a conflict instead of overwriting local edits", () => {
    let s = reduce(opened(), { type: "edited", text: "meins" });
    s = reduce(s, { type: "external", seq: 1, version: version("fremd"), at: 5 });
    expect(s.buffer).toBe("meins");
    expect(s.base.text).toBe("eins");
    expect(s.pending?.text).toBe("fremd");
    expect(s.disk).toBe("changed");
  });

  it("keeps the conflict open when the user keeps their version", () => {
    let s = reduce(opened(), { type: "edited", text: "meins" });
    s = reduce(s, { type: "external", seq: 1, version: version("fremd"), at: 5 });
    s = reduce(s, { type: "keepMine" });
    expect(s.conflictKept).toBe(true);
    expect(s.pending?.text).toBe("fremd");
    expect(s.buffer).toBe("meins");
    s = reduce(s, { type: "external", seq: 2, version: version("fremd 2"), at: 6 });
    expect(s.pending?.text).toBe("fremd 2");
    expect(s.buffer).toBe("meins");
  });

  it("only discards local edits on the explicit discard action", () => {
    let s = reduce(opened(), { type: "edited", text: "meins" });
    s = reduce(s, { type: "external", seq: 1, version: version("fremd"), at: 5 });
    s = reduce(s, { type: "discardMine" });
    expect(s.buffer).toBe("fremd");
    expect(s.pending).toBeNull();
    expect(s.disk).toBe("current");
  });

  it("clears dirty state and conflicts after a successful save", () => {
    let s = reduce(opened(), { type: "edited", text: "meins" });
    s = reduce(s, { type: "external", seq: 1, version: version("fremd"), at: 5 });
    s = reduce(s, { type: "saved", text: "meins", token: "t-saved", at: 9 });
    expect(isDirty(s)).toBe(false);
    expect(s.pending).toBeNull();
    expect(s.base.token).toBe("t-saved");
    expect(s.savedAt).toBe(9);
  });

  it("stays dirty when typing continued during a save", () => {
    let s = reduce(opened(), { type: "edited", text: "meins" });
    s = reduce(s, { type: "edited", text: "meins und mehr" });
    s = reduce(s, { type: "saved", text: "meins", token: "t-saved", at: 9 });
    expect(isDirty(s)).toBe(true);
  });

  it("ignores the echo of its own save and stale events", () => {
    let s = reduce(opened(), { type: "edited", text: "meins" });
    s = reduce(s, { type: "saved", text: "meins", token: "t-meins", at: 9 });
    s = reduce(s, { type: "external", seq: 3, version: version("meins"), at: 10 });
    expect(s.lastExternalAt).toBeNull();
    s = reduce(s, { type: "external", seq: 2, version: version("alt"), at: 11 });
    expect(s.buffer).toBe("meins");
  });

  it("keeps the buffer when the file goes missing or cannot be read", () => {
    let s = reduce(opened(), { type: "missing", seq: 1 });
    expect(s.disk).toBe("missing");
    expect(s.buffer).toBe("eins");
    s = reduce(s, { type: "readError", seq: 2, problem: { code: "encoding" } });
    expect(s.disk).toBe("error");
    expect(s.buffer).toBe("eins");
    s = reduce(s, { type: "external", seq: 3, version: version("wieder"), at: 4 });
    expect(s.disk).toBe("current");
    expect(s.problem).toBeNull();
  });

  it("moves to a new file after save as", () => {
    let s = reduce(opened(), { type: "edited", text: "meins" });
    s = reduce(s, {
      type: "savedAs",
      text: "meins",
      token: "t-neu",
      at: 3,
      file: { sessionId: 2, path: "/d/b.md", name: "b.md", dir: "/d" },
    });
    expect(s.file.path).toBe("/d/b.md");
    expect(s.file.sessionId).toBe(2);
    expect(isDirty(s)).toBe(false);
    expect(s.lastSeq).toBe(0);
  });
});
