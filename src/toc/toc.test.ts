import { describe, expect, it } from "vitest";
import { numberHeadings } from "./toc";

const hd = (level: number, text: string) => ({ level, text, id: text, line: 1 });

describe("numberHeadings", () => {
  it("treats a single leading top heading as the title", () => {
    const n = numberHeadings([hd(1, "Plan"), hd(2, "Ziele"), hd(3, "Detail"), hd(2, "Risiken")]);
    expect(n.map((x) => x.number)).toEqual(["", "1", "1.1", "2"]);
  });

  it("numbers several top headings from 1", () => {
    const n = numberHeadings([hd(2, "A"), hd(3, "B"), hd(2, "C")]);
    expect(n.map((x) => x.number)).toEqual(["1", "1.1", "2"]);
  });

  it("fills skipped levels with zero", () => {
    const n = numberHeadings([hd(2, "A"), hd(4, "B"), hd(2, "C")]);
    expect(n.map((x) => x.number)).toEqual(["1", "1.0.1", "2"]);
  });

  it("adds no numbers when the headings bring their own", () => {
    const n = numberHeadings([hd(2, "1. Einleitung"), hd(2, "2. Aufbau"), hd(3, "2.1 Teile")]);
    expect(n.every((x) => x.number === "")).toBe(true);
  });
});
