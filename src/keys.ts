// Keyboard shortcuts across platforms and keyboard layouts.

export type Platform = "windows" | "macos" | "linux";

export type Action =
  | "open"
  | "save"
  | "saveAs"
  | "find"
  | "escape"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "viewPreview"
  | "viewSplit"
  | "viewSource"
  | "toggleToc"
  | "settings"
  | "nextChange"
  | "prevChange"
  | "closeTab"
  | "reopenTab"
  | "nextTab"
  | "prevTab";

export interface KeyInput {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The letter the user meant: the layout's Latin letter, else the key position. */
function letter(e: KeyInput): string | null {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code);
  return m?.[1] ? m[1].toLowerCase() : null;
}

export function shortcutFor(e: KeyInput, platform: Platform): Action | null {
  const mod = platform === "macos" ? e.metaKey : e.ctrlKey;
  const otherMod = platform === "macos" ? e.ctrlKey : e.metaKey;

  if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) return "escape";
  if (e.key === "F8" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    return e.shiftKey ? "prevChange" : "nextChange";
  }
  // Ctrl+Tab cycles tabs on every platform, as in browsers.
  if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
    return e.shiftKey ? "prevTab" : "nextTab";
  }
  // AltGr reports Ctrl+Alt on Windows; Alt combinations are left to the OS.
  if (!mod || otherMod || e.altKey) return null;

  if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") return "zoomIn";
  if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return "zoomOut";
  // Shift+0 is "=" on German layouts; some engines still report key "0".
  if (!e.shiftKey && (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0"))
    return "zoomReset";
  if (e.shiftKey && e.code === "Digit0") return "zoomIn";
  if (!e.shiftKey && (e.key === "1" || e.code === "Digit1")) return "viewPreview";
  if (!e.shiftKey && (e.key === "2" || e.code === "Digit2")) return "viewSplit";
  if (!e.shiftKey && (e.key === "3" || e.code === "Digit3")) return "viewSource";
  if (e.key === "," && !e.shiftKey) return "settings";

  switch (letter(e)) {
    case "o":
      return e.shiftKey ? null : "open";
    case "s":
      return e.shiftKey ? "saveAs" : "save";
    case "f":
      return e.shiftKey ? null : "find";
    case "t":
      return e.shiftKey ? "reopenTab" : null;
    case "w":
      return e.shiftKey ? null : "closeTab";
    case "b":
      return e.shiftKey ? null : "toggleToc";
    default:
      return null;
  }
}

/** Actions the macOS menu bar carries with their shortcut (src-tauri/src/menu.rs). */
const MAC_MENU: ReadonlySet<Action> = new Set<Action>([
  "open",
  "save",
  "saveAs",
  "find",
  "viewPreview",
  "viewSplit",
  "viewSource",
  "toggleToc",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "settings",
  "closeTab",
  "reopenTab",
]);

/**
 * Whether the native menu already runs this shortcut and reports it as a
 * menu event, so the key handler must leave it alone to avoid running it twice.
 */
export function menuOwnsShortcut(action: Action, platform: Platform): boolean {
  return platform === "macos" && MAC_MENU.has(action);
}

/** Human-readable shortcut, e.g. "Strg+Umschalt+S" or "⇧⌘S". */
export function shortcutLabel(platform: Platform, combo: string, lang: string): string {
  if (platform === "macos") {
    // macOS lists Shift before Command.
    const shift = combo.includes("Shift+") ? "⇧" : "";
    const cmd = combo.includes("Mod+") ? "⌘" : "";
    return `${shift}${cmd}${combo.replace("Mod+", "").replace("Shift+", "")}`;
  }
  const de = lang === "de";
  return combo
    .replace("Mod+", de ? "Strg+" : "Ctrl+")
    .replace("Shift+", de ? "Umschalt+" : "Shift+");
}
