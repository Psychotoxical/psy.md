import { describe, expect, it } from "vitest";
import { createScrollGuard, lineToOffset, offsetToLine } from "./scrollsync";

const entries = [
  { line: 1, top: 0 },
  { line: 11, top: 100 },
  { line: 21, top: 300 },
];

describe("line and offset mapping", () => {
  it("interpolates lines to offsets", () => {
    expect(lineToOffset(entries, 6)).toBe(50);
    expect(lineToOffset(entries, 16)).toBe(200);
    expect(lineToOffset(entries, 30)).toBe(300);
    expect(lineToOffset(entries, 0)).toBe(0);
    expect(lineToOffset([], 5)).toBe(0);
  });

  it("interpolates offsets to lines", () => {
    expect(offsetToLine(entries, 150)).toBe(13.5);
    expect(offsetToLine(entries, 50)).toBe(6);
    expect(offsetToLine(entries, 900)).toBe(21);
    expect(offsetToLine(entries, -5)).toBe(1);
  });
});

describe("scroll guard", () => {
  it("ignores scroll events caused by syncing", () => {
    let now = 1000;
    const guard = createScrollGuard(() => now);
    guard.userInput("editor");
    expect(guard.shouldSync("editor")).toBe(true);
    guard.programmatic("preview");
    expect(guard.shouldSync("preview")).toBe(false);
    now += 500;
    expect(guard.shouldSync("preview")).toBe(false); // editor still drives
    guard.userInput("preview");
    expect(guard.shouldSync("preview")).toBe(true);
    expect(guard.shouldSync("editor")).toBe(false);
  });
});
