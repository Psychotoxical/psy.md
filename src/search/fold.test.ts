import { describe, expect, it } from "vitest";
import { findMatches } from "./fold";

describe("findMatches", () => {
  it("matches case-insensitively, including umlauts", () => {
    expect(findMatches("Äpfel und äpfel", "ÄPFEL")).toEqual([
      [0, 5],
      [10, 15],
    ]);
  });

  it("keeps umlauts distinct from their base letters", () => {
    expect(findMatches("schön schon", "schon")).toEqual([[6, 11]]);
  });

  it("matches composed and decomposed umlauts in both directions", () => {
    expect(findMatches("Müller", "MÜLLER")).toEqual([[0, 7]]);
    expect(findMatches("Müller", "müller")).toEqual([[0, 6]]);
  });

  it("matches capital sharp s against ß", () => {
    expect(findMatches("STRAẞE", "straße")).toEqual([[0, 6]]);
  });

  it("finds nothing for an empty or blank query", () => {
    expect(findMatches("abc", "")).toEqual([]);
  });

  it("reports UTF-16 ranges around astral characters", () => {
    expect(findMatches("😀a😀A", "a")).toEqual([
      [2, 3],
      [5, 6],
    ]);
  });

  it("does not report overlapping matches", () => {
    expect(findMatches("aaa", "aa")).toEqual([[0, 2]]);
  });
});
