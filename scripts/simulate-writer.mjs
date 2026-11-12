// Simulates another program writing a Markdown file, for manual and timed
// tests of live reload.
//
//   node scripts/simulate-writer.mjs <file> replace <from> <to> [atomic|inplace]
//   node scripts/simulate-writer.mjs <file> append <text> [atomic|inplace]
//   node scripts/simulate-writer.mjs <file> burst <count> <intervalMs>
//   node scripts/simulate-writer.mjs <file> truncate-then-write <text>
//
// Prints the wall-clock time (epoch ms) of the final write.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [file, mode, a, b, c] = process.argv.slice(2);
if (!file || !mode) {
  console.error("usage: simulate-writer.mjs <file> <mode> ...");
  process.exit(2);
}

function write(text, how = "atomic") {
  if (how === "inplace") {
    writeFileSync(file, text);
  } else {
    const tmp = join(dirname(file), `.${Date.now()}.writer.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }
  return Date.now();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let at = 0;
const text = readFileSync(file, "utf8");

switch (mode) {
  case "replace":
    if (!text.includes(a)) {
      console.error("text to replace not found");
      process.exit(1);
    }
    at = write(text.replace(a, b.replaceAll("\\n", "\n")), c);
    break;
  case "append":
    at = write(`${text}${a.replaceAll("\\n", "\n")}`, b);
    break;
  case "burst": {
    const n = Number(a ?? 20);
    const every = Number(b ?? 30);
    let t = text;
    for (let i = 0; i < n; i++) {
      t += `\nBurst line ${i + 1} of ${n}.\n`;
      at = write(t, "inplace");
      await sleep(every);
    }
    break;
  }
  case "truncate-then-write":
    writeFileSync(file, "");
    await sleep(40);
    at = write(`${text}${(a ?? "").replaceAll("\\n", "\n")}`, "inplace");
    break;
  default:
    console.error(`unknown mode ${mode}`);
    process.exit(2);
}
console.log(at);
