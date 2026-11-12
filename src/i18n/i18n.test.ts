import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import de from "./de.json";
import en from "./en.json";
import { format, setLanguage, t } from "./index";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

describe("translations", () => {
  it("German and English have the same keys", () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps the same placeholders in both languages", () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [k, v] of Object.entries(en)) {
      expect(vars((de as Record<string, string>)[k] ?? ""), k).toEqual(vars(v));
    }
  });

  it("every key used in the source exists", () => {
    const root = join(__dirname, "..");
    const used = new Set<string>();
    for (const f of sourceFiles(root)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9.-]+)"/g)) used.add(m[1] as string);
      for (const m of src.matchAll(/data-i18n(?:-[a-z]+)?="([a-zA-Z0-9.-]+)"/g))
        used.add(m[1] as string);
    }
    const html = readFileSync(join(root, "..", "index.html"), "utf8");
    for (const m of html.matchAll(/data-i18n(?:-[a-z]+)?="([a-zA-Z0-9.-]+)"/g))
      used.add(m[1] as string);
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it("fills placeholders and falls back to English", () => {
    expect(format("{n} von {m}", { n: 1, m: 2 })).toBe("1 von 2");
    setLanguage("de");
    expect(t("find.count", { i: 2, n: 5 })).toBe("2 von 5");
    setLanguage("en");
    expect(t("find.count", { i: 2, n: 5 })).toBe("2 of 5");
  });
});
