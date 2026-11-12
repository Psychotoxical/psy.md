// Source editor (CodeMirror 6). Loaded on first use of the source or split
// view, so preview-only sessions never pay for it.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { classHighlighter, tags } from "@lezer/highlight";

const External = Annotation.define<boolean>();

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--syn-heading)", fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--syn-link)" },
  { tag: tags.monospace, color: "var(--syn-string)" },
  { tag: tags.quote, color: "var(--fg-2)", fontStyle: "italic" },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: "var(--syn-number)" },
  { tag: tags.meta, color: "var(--fg-faint)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    fontSize: "calc(14px * var(--zoom))",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "20px 0 40vh", caretColor: "var(--caret)" },
  ".cm-line": { padding: "0 24px 0 14px" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--fg-faint)",
    border: "none",
    borderRight: "1px solid var(--line)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "3.5ch" },
  ".cm-activeLine": { backgroundColor: "var(--tint)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--tint)", color: "var(--fg-2)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--caret)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "var(--select)" },
  ".cm-searchMatch": { backgroundColor: "var(--hit)" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--hit-current)",
    color: "var(--hit-current-fg)",
  },
  ".cm-panels": { display: "none" },
});

export interface EditorHooks {
  onChange(text: string): void;
  onScroll(): void;
  onUserInput(): void;
}

export class Editor {
  readonly view: EditorView;
  private readonly historyCompartment = new Compartment();
  private readonly extensions: Extension[];
  private query = "";

  constructor(parent: HTMLElement, text: string, hooks: EditorHooks, label: string) {
    this.extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      EditorView.lineWrapping,
      this.historyCompartment.of(history()),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages, pasteURLAsLink: false }),
      syntaxHighlighting(markdownStyle),
      syntaxHighlighting(classHighlighter),
      search({ createPanel: () => ({ dom: document.createElement("div") }) }),
      theme,
      EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) {
          hooks.onChange(u.state.doc.toString());
        }
      }),
      EditorView.domEventHandlers({
        wheel: () => hooks.onUserInput(),
        keydown: () => hooks.onUserInput(),
        mousedown: () => hooks.onUserInput(),
        touchstart: () => hooks.onUserInput(),
      }),
    ];
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: text, extensions: this.extensions }),
    });
    this.view.scrollDOM.addEventListener("scroll", () => hooks.onScroll(), { passive: true });
  }

  /** The state of the shown document, kept per tab (undo history included). */
  snapshot(): EditorState {
    return this.view.state;
  }

  /**
   * Shows another tab: its kept state, or a fresh one. `text` wins over the
   * kept state when the file changed while the tab was in the background.
   */
  load(state: EditorState | null, text: string): void {
    this.view.setState(state ?? EditorState.create({ doc: text, extensions: this.extensions }));
    this.setText(text, false);
    if (this.query) this.setQuery(this.query);
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  /** Replaces the text without reporting a change; optionally clears undo. */
  setText(text: string, resetHistory: boolean): void {
    if (text === this.text) return;
    const sel = this.view.state.selection.main;
    const anchor = Math.min(sel.anchor, text.length);
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor },
      annotations: External.of(true),
    });
    if (resetHistory) {
      this.view.dispatch({ effects: this.historyCompartment.reconfigure([]) });
      this.view.dispatch({ effects: this.historyCompartment.reconfigure(history()) });
    }
  }

  focus(): void {
    this.view.focus();
  }

  hasFocus(): boolean {
    return this.view.hasFocus;
  }

  /** Fractional source line at the top of the editor viewport. */
  topLine(): number {
    const scroller = this.view.scrollDOM;
    const top = scroller.getBoundingClientRect().top;
    const block = this.view.lineBlockAtHeight(top - this.view.documentTop);
    const line = this.view.state.doc.lineAt(block.from).number;
    const frac = block.height > 0 ? (top - this.view.documentTop - block.top) / block.height : 0;
    return line + Math.max(0, Math.min(1, frac));
  }

  scrollToLine(line: number): void {
    const doc = this.view.state.doc;
    const n = Math.max(1, Math.min(doc.lines, Math.floor(line)));
    const block = this.view.lineBlockAt(doc.line(n).from);
    const frac = line - Math.floor(line);
    const y = block.top + frac * block.height;
    const scroller = this.view.scrollDOM;
    scroller.scrollTop =
      y + (this.view.documentTop - scroller.getBoundingClientRect().top) + scroller.scrollTop;
  }

  revealLine(line: number): void {
    const doc = this.view.state.doc;
    const n = Math.max(1, Math.min(doc.lines, line));
    const pos = doc.line(n).from;
    this.view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 16 }),
    });
  }

  // ---------------------------------------------------------------- search

  private makeQuery(q: string): SearchQuery {
    const needle = q.normalize("NFC").toLowerCase();
    return new SearchQuery({
      search: q,
      caseSensitive: false,
      literal: true,
      // Only exact matches: "a" must not find "ä".
      test: (match) => match.normalize("NFC").toLowerCase() === needle,
    });
  }

  setQuery(q: string): void {
    this.query = q;
    const query = this.makeQuery(q);
    openSearchPanel(this.view);
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  clearQuery(): void {
    this.query = "";
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
  }

  count(): { index: number; total: number } {
    const query = getSearchQuery(this.view.state);
    if (!this.query || !query.valid) return { index: 0, total: 0 };
    const sel = this.view.state.selection.main;
    let total = 0;
    let index = 0;
    const cursor = query.getCursor(this.view.state);
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      total++;
      if (r.value.from === sel.from && r.value.to === sel.to) index = total;
    }
    return { index, total };
  }

  next(): void {
    if (this.query) findNext(this.view);
  }

  previous(): void {
    if (this.query) findPrevious(this.view);
  }
}
