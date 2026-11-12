import { describe, expect, it } from "vitest";
import { classifyHref } from "./links";

describe("classifyHref", () => {
  it("treats fragments as anchors in this document", () => {
    expect(classifyHref("#%C3%BCber-uns")).toEqual({ kind: "anchor", id: "über-uns" });
  });

  it("opens web and mail links outside", () => {
    expect(classifyHref("https://example.com/a?b=1")).toEqual({
      kind: "external",
      url: "https://example.com/a?b=1",
    });
    expect(classifyHref("mailto:a@example.com").kind).toBe("external");
    expect(classifyHref("HTTP://example.com").kind).toBe("external");
  });

  it("resolves relative paths as documents with an optional fragment", () => {
    expect(classifyHref("sub/zwei.md#teil-1")).toEqual({
      kind: "doc",
      path: "sub/zwei.md",
      fragment: "teil-1",
    });
    expect(classifyHref("../a.markdown")).toEqual({
      kind: "doc",
      path: "../a.markdown",
      fragment: null,
    });
    expect(classifyHref("file:///tmp/x.md").kind).toBe("doc");
  });

  it("blocks everything else", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://example.com/x",
      "//example.com/x",
      "",
      "vbscript:x",
      "ms-settings:display",
    ]) {
      expect(classifyHref(href).kind, href).toBe("blocked");
    }
  });
});
