import { describe, expect, it } from "vitest";
import { type KeyInput, menuOwnsShortcut, shortcutFor, shortcutLabel } from "./keys";

describe("menuOwnsShortcut", () => {
  it("leaves change navigation to the key handler on macOS", () => {
    expect(menuOwnsShortcut("nextChange", "macos")).toBe(false);
    expect(menuOwnsShortcut("prevChange", "macos")).toBe(false);
    expect(menuOwnsShortcut("escape", "macos")).toBe(false);
  });

  it("lets the macOS menu run the shortcuts it lists", () => {
    for (const a of [
      "open",
      "save",
      "saveAs",
      "find",
      "viewSplit",
      "zoomIn",
      "settings",
    ] as const) {
      expect(menuOwnsShortcut(a, "macos")).toBe(true);
    }
  });

  it("owns nothing on Windows and Linux", () => {
    expect(menuOwnsShortcut("save", "windows")).toBe(false);
    expect(menuOwnsShortcut("save", "linux")).toBe(false);
  });
});

const ev = (over: Partial<KeyInput>): KeyInput => ({
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("shortcutFor", () => {
  it("maps every common plus key to zoom in", () => {
    for (const e of [
      ev({ key: "+", code: "BracketRight", ctrlKey: true }), // German layout
      ev({ key: "=", code: "Equal", ctrlKey: true }), // US without shift
      ev({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }), // US with shift
      ev({ key: "+", code: "NumpadAdd", ctrlKey: true }),
    ]) {
      expect(shortcutFor(e, "windows"), JSON.stringify(e)).toBe("zoomIn");
    }
  });

  it("maps minus and zero on several layouts", () => {
    expect(shortcutFor(ev({ key: "-", code: "Slash", ctrlKey: true }), "linux")).toBe("zoomOut");
    expect(shortcutFor(ev({ key: "-", code: "Minus", ctrlKey: true }), "linux")).toBe("zoomOut");
    expect(shortcutFor(ev({ key: "-", code: "NumpadSubtract", ctrlKey: true }), "linux")).toBe(
      "zoomOut",
    );
    expect(shortcutFor(ev({ key: "0", code: "Digit0", ctrlKey: true }), "linux")).toBe("zoomReset");
    expect(shortcutFor(ev({ key: "0", code: "Numpad0", ctrlKey: true }), "linux")).toBe(
      "zoomReset",
    );
  });

  it('treats Ctrl+Shift+0 ("=" on German layouts) as zoom in, not reset', () => {
    expect(
      shortcutFor(ev({ key: "0", code: "Digit0", ctrlKey: true, shiftKey: true }), "windows"),
    ).toBe("zoomIn");
    expect(
      shortcutFor(ev({ key: "=", code: "Digit0", ctrlKey: true, shiftKey: true }), "windows"),
    ).toBe("zoomIn");
  });

  it("uses Cmd on macOS and ignores Ctrl there", () => {
    expect(shortcutFor(ev({ key: "o", code: "KeyO", metaKey: true }), "macos")).toBe("open");
    expect(shortcutFor(ev({ key: "o", code: "KeyO", ctrlKey: true }), "macos")).toBeNull();
    expect(shortcutFor(ev({ key: "o", code: "KeyO", metaKey: true }), "windows")).toBeNull();
  });

  it("follows the layout for Latin letters and falls back to the key position otherwise", () => {
    expect(shortcutFor(ev({ key: "o", code: "KeyS", ctrlKey: true }), "linux")).toBe("open"); // Dvorak
    expect(shortcutFor(ev({ key: "щ", code: "KeyO", ctrlKey: true }), "linux")).toBe("open");
    expect(shortcutFor(ev({ key: "ы", code: "KeyS", ctrlKey: true }), "linux")).toBe("save");
  });

  it("distinguishes save and save as", () => {
    expect(shortcutFor(ev({ key: "s", code: "KeyS", ctrlKey: true }), "windows")).toBe("save");
    expect(
      shortcutFor(ev({ key: "S", code: "KeyS", ctrlKey: true, shiftKey: true }), "windows"),
    ).toBe("saveAs");
    expect(shortcutFor(ev({ key: "f", code: "KeyF", ctrlKey: true }), "windows")).toBe("find");
  });

  it("ignores AltGr combinations", () => {
    expect(
      shortcutFor(ev({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true }), "windows"),
    ).toBeNull();
  });

  it("moves between changes with F8 and Shift+F8", () => {
    expect(shortcutFor(ev({ key: "F8", code: "F8" }), "windows")).toBe("nextChange");
    expect(shortcutFor(ev({ key: "F8", code: "F8", shiftKey: true }), "macos")).toBe("prevChange");
    expect(shortcutFor(ev({ key: "F8", code: "F8", ctrlKey: true }), "windows")).toBeNull();
  });

  it("labels shortcuts per platform and language", () => {
    expect(shortcutLabel("windows", "Mod+Shift+S", "de")).toBe("Strg+Umschalt+S");
    expect(shortcutLabel("windows", "Mod+O", "en")).toBe("Ctrl+O");
    expect(shortcutLabel("linux", "Shift+F8", "de")).toBe("Umschalt+F8");
    expect(shortcutLabel("macos", "Mod+Shift+S", "de")).toBe("⇧⌘S");
  });

  it("maps Escape without modifiers", () => {
    expect(shortcutFor(ev({ key: "Escape", code: "Escape" }), "windows")).toBe("escape");
  });
});
