// Syntax highlighting for one code block with the same Lezer grammars the
// editor uses. Each language loads on first use; large blocks stay plain.

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";

const MAX_CHARS = 120_000;

export async function highlightOne(pre: HTMLElement): Promise<void> {
  pre.dataset.hl = "busy";
  const code = pre.querySelector("code");
  const lang = pre.dataset.lang ?? "";
  const text = code?.textContent ?? "";
  const desc = LanguageDescription.matchLanguageName(languages, lang, true);
  if (!code || !desc || text.length > MAX_CHARS) {
    pre.dataset.hl = "plain";
    return;
  }
  const support = desc.support ?? (await desc.load());
  if (!pre.isConnected || code.textContent !== text) return;
  const tree = support.language.parser.parse(text);
  const frag = document.createDocumentFragment();
  highlightCode(
    text,
    tree,
    classHighlighter,
    (piece, classes) => {
      if (!classes) frag.append(piece);
      else {
        const span = document.createElement("span");
        span.className = classes;
        span.textContent = piece;
        frag.append(span);
      }
    },
    () => frag.append("\n"),
  );
  code.replaceChildren(frag);
  pre.dataset.hl = "done";
}
