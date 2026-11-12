// Writes synthetic Markdown documents for performance measurements.
// Usage: node scripts/gen-samples.mjs <outDir>
// All text is generated; nothing comes from real documents.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "perf-samples";
mkdirSync(out, { recursive: true });

const words =
  "change snapshot reader writer queue file folder render block section token update watch editor preview contents limit value setting window session".split(
    " ",
  );
let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const word = () => words[Math.floor(rand() * words.length)];
const sentence = (n = 12) => {
  const s = Array.from({ length: n }, word).join(" ");
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
};
const paragraph = () => Array.from({ length: 4 }, () => sentence(8 + Math.floor(rand() * 10))).join(" ");

function table(rows) {
  const lines = ["| Name | Kind | Size | Note |", "|:-----|:-----|-----:|:-----|"];
  for (let i = 0; i < rows; i++) {
    lines.push(`| item-${i} | ${word()} | ${Math.floor(rand() * 10000)} B | ${sentence(6)} |`);
  }
  return lines.join("\n");
}

function code(lines) {
  const body = Array.from(
    { length: lines },
    (_, i) => `    let value_${i} = compute("${word()}", ${i}); // ${word()} ${word()}`,
  ).join("\n");
  return `\`\`\`rust\nfn generated() {\n${body}\n}\n\`\`\``;
}

function section(i) {
  return [
    `## Section ${i}`,
    paragraph(),
    `### Details ${i}`,
    `- ${sentence(6)}\n- ${sentence(7)}\n  - ${sentence(5)}\n- [x] ${sentence(4)}\n- [ ] ${sentence(4)}`,
    paragraph(),
    i % 3 === 0 ? table(8) : code(6),
    `> ${sentence(14)}`,
  ].join("\n\n");
}

function doc(targetBytes) {
  const parts = ["# Generated document", paragraph()];
  let size = 0;
  for (let i = 1; size < targetBytes; i++) {
    const s = section(i);
    parts.push(s);
    size += Buffer.byteLength(s) + 2;
  }
  return `${parts.join("\n\n")}\n`;
}

const files = {
  "doc-100k.md": doc(100 * 1024),
  "doc-1m.md": doc(1024 * 1024),
  "doc-10m.md": doc(10 * 1024 * 1024),
  "tables.md": `# Tables\n\n${Array.from({ length: 20 }, () => table(40)).join("\n\n")}\n`,
  "code.md": `# Code\n\n${Array.from({ length: 60 }, () => code(30)).join("\n\n")}\n`,
  "mermaid.md": `# Diagrams\n\n${Array.from(
    { length: 12 },
    (_, i) =>
      `## Diagram ${i + 1}\n\n\`\`\`mermaid\nflowchart LR\n  A${i}[Start] --> B${i}{Check}\n  B${i} -- yes --> C${i}[Write]\n  B${i} -- no --> D${i}[Wait]\n  D${i} --> B${i}\n\`\`\``,
  ).join("\n\n")}\n`,
};
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(out, name), text);
  console.log(name, Buffer.byteLength(text));
}
