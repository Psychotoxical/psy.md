// Application controller: ties the document model, preview, editor, find,
// contents and settings together. All file and window effects go through
// ./ipc; all document state changes go through ./doc/model.

import type { EditorState } from "@codemirror/state";
import { summarizeChange } from "./doc/change";
import {
  type DiskVersion,
  type DocState,
  hasConflict,
  isDirty,
  openDoc,
  reduce,
} from "./doc/model";
import type { Editor } from "./editor/editor";
import { applyI18n, clock, type Key, language, onLanguageChange, setLanguage, t } from "./i18n";
import { type DocEvent, ipc, isCmdError, type StartupState } from "./ipc";
import { type Action, menuOwnsShortcut, type Platform, shortcutFor, shortcutLabel } from "./keys";
import { relabel } from "./preview/decorate";
import { classifyHref } from "./preview/links";
import { type KeptMarks, Preview, type ShowResult } from "./preview/preview";
import { FindBar } from "./search/findbar";
import { PreviewSearch } from "./search/preview-search";
import {
  addRecent,
  clampZoom,
  readSession,
  readSettings,
  type Session,
  type Settings,
  type ViewMode,
  ZOOM_STEP,
} from "./settings";
import { createScrollGuard } from "./split/scrollsync";
import { Splitter } from "./split/split";
import { TabBar, type TabState } from "./tabs/tabbar";
import { activeAfterClose, ClosedTabs, type CloseKind, findTab, toClose } from "./tabs/tabs";
import { Toc, type TocEntry } from "./toc/toc";
import { ask, isDialogOpen } from "./ui/dialog";
import { byId, h } from "./ui/dom";
import { closeMenu, isMenuOpen, type MenuEntry, openMenu } from "./ui/menu";
import { openSettings } from "./ui/settings-dialog";
import { hideToast, isToastOpen, toast } from "./ui/toast";

const MD_NAME = /\.(md|markdown|mdown|mkd|mkdn|mdwn|txt)$/i;

function errorText(e: unknown): string {
  if (isCmdError(e)) {
    const key = `error.${e.code}` as Key;
    const byte = /^byte (\d+)$/.exec(e.detail ?? "");
    const detail = byte ? t("error.byteAt", { n: byte[1] ?? "" }) : (e.detail ?? "");
    const s = t(key, { detail });
    return s === key ? t("error.unknown", { detail: e.detail ?? e.code }) : s;
  }
  return t("error.unknown", { detail: e instanceof Error ? e.message : String(e) });
}

function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

type FootLeft =
  | { kind: "saved"; at: number }
  | {
      kind: "updated";
      at: number;
      since: number | null;
      count: number;
      removed: boolean;
      sections: TocEntry[];
    }
  | { kind: "conflict"; at: number; where: string };

/** One open file. Only the active tab is on screen; the others keep their state here. */
interface Tab {
  doc: DocState;
  watchError: string | null;
  footLeft: FootLeft | null;
  conflictWhere: string;
  /** Editor state with its own undo history, once the editor has shown this tab. */
  editorState: EditorState | null;
  /** Reading position: source line at the top. */
  line: number;
  marks: KeptMarks | null;
  /** Block keys on screen when the tab was last shown; null if never shown. */
  seen: Set<string> | null;
  /** Another program changed the file while the tab was in the background. */
  changedAt: number | null;
  warned: boolean;
}

export class App {
  private readonly app = byId("app");
  private readonly platform: Platform;
  private settings: Settings;
  private session: Session;
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private readonly closed = new ClosedTabs();
  private readonly tabBar: TabBar;
  private editor: Editor | null = null;
  private editorLoading: Promise<Editor> | null = null;
  private readonly preview: Preview;
  private readonly toc: Toc;
  private readonly find: FindBar;
  private readonly splitter: Splitter;
  private readonly guard = createScrollGuard();
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private sessionTimer: ReturnType<typeof setTimeout> | undefined;
  private settingsTimer: ReturnType<typeof setTimeout> | undefined;
  private saving = false;
  /** The running save or save as; opening and closing wait for it. */
  private saveJob: Promise<boolean> | null = null;
  /** The reader interacted with the window since the last external update. */
  private looked = true;
  private wheelAcc = 0;
  private lastMissing: string | null = null;

  // The document state of the tab on screen; the rest of the controller
  // works on it as it did with a single document.
  private get doc(): DocState | null {
    return this.active?.doc ?? null;
  }
  private set doc(d: DocState | null) {
    if (this.active && d) this.active.doc = d;
  }
  private get footLeft(): FootLeft | null {
    return this.active?.footLeft ?? null;
  }
  private set footLeft(f: FootLeft | null) {
    if (this.active) this.active.footLeft = f;
  }
  private get conflictWhere(): string {
    return this.active?.conflictWhere ?? "";
  }
  private set conflictWhere(w: string) {
    if (this.active) this.active.conflictWhere = w;
  }
  private get watchError(): string | null {
    return this.active?.watchError ?? null;
  }

  constructor(state: StartupState) {
    this.platform = state.platform;
    this.settings = readSettings(state.settings);
    this.session = readSession(state.session);

    this.preview = new Preview(byId("pane-preview"), byId("doc"), {
      sessionId: () => this.active?.doc.file.sessionId ?? 0,
      marksEnabled: () => this.settings.marks,
      diagramTheme: () => this.diagramTheme(),
      diagramFont: () => getComputedStyle(document.documentElement).getPropertyValue("--font-ui"),
      beforeApply: () => this.find.suspend(),
      afterApply: () => {
        this.find.refresh();
        this.trackSection();
      },
      afterAsyncWork: () => {
        this.preview.invalidateGeometry();
        this.find.refresh();
      },
    });
    this.toc = new Toc(byId<HTMLOListElement>("toc-list"), byId("toc-empty"), (entry) => {
      if (this.view() === "source") this.editor?.revealLine(entry.line);
      else this.preview.scrollToHeading(entry.id);
      if (this.isNarrow()) delete this.app.dataset.tocOpen;
      this.trackSection();
    });
    this.find = new FindBar(
      byId("find"),
      byId<HTMLInputElement>("find-input"),
      byId<HTMLOutputElement>("find-count"),
      new PreviewSearch(byId("doc")),
      () => this.editor,
      () =>
        this.view() === "source" || (this.view() === "split" && this.editor?.hasFocus())
          ? "editor"
          : "preview",
    );
    this.splitter = new Splitter(byId("splitter"), this.app, (r) => {
      this.session.split = r;
      this.persistSession();
    });
    const at = (i: number, fn: (tab: Tab) => void) => {
      const tab = this.tabs[i];
      if (tab) fn(tab);
    };
    this.tabBar = new TabBar(byId("tabs"), {
      select: (i) => at(i, (tab) => void this.activate(tab)),
      close: (i) => at(i, (tab) => void this.closeTab(tab)),
      menu: (i, anchor) => this.openTabMenu(i, anchor),
      add: () => void this.openDialog(),
    });
  }

  // ------------------------------------------------------------- startup

  async start(startupFiles: string[]): Promise<void> {
    setLanguage(this.settings.language);
    applyI18n();
    this.applyAppearance();
    this.splitter.set(this.session.split);
    this.app.dataset.toc = this.session.toc ? "on" : "off";
    this.setViewAttr(this.session.view);
    byId("empty-kbd").textContent = this.keyLabel("Mod+O");
    this.bindUi();
    onLanguageChange(() => {
      applyI18n();
      relabel(byId("doc"));
      this.refreshChrome();
      void ipc.setLanguage(language());
    });
    void ipc.setLanguage(language());

    // Tabs of the last session open in the background (read and watched, not
    // rendered); files handed over at start open after them.
    const restore = this.session.tabs;
    const wanted = restore[this.session.activeTab]?.path ?? null;
    for (const t of restore) {
      await this.openPath(t.path, { background: true, quietMissing: true, line: t.line });
    }
    for (const p of startupFiles) await this.openPath(p, { background: true });
    const last = startupFiles.at(-1);
    const paths = this.tabs.map((t) => t.doc.file.path);
    const pick = last ?? wanted;
    const first = this.tabs[pick ? Math.max(0, findTab(paths, pick)) : 0];
    if (!first && wanted) this.lastMissing = wanted;
    // Show the window as soon as the document is on screen, at the latest
    // after half a second for very large files.
    const ready = first ? this.activate(first) : Promise.resolve();
    await Promise.race([ready, new Promise((r) => setTimeout(r, 500))]);
    if (!this.active) this.showEmpty();
    await ipc.frontendReady();
    void ipc.perfMark("ui-ready", String(this.preview.blockCount));
    if (this.session.view !== "preview" && this.doc) void this.setView(this.session.view);
  }

  // ------------------------------------------------------------ bindings

  private bindUi(): void {
    byId("file-btn").addEventListener("click", (e) =>
      this.openFileMenu(e.currentTarget as HTMLElement),
    );
    byId("more-btn").addEventListener("click", (e) =>
      this.openMoreMenu(e.currentTarget as HTMLElement),
    );
    for (const b of byId("views").querySelectorAll<HTMLButtonElement>("button")) {
      b.addEventListener("click", () => void this.setView(b.dataset.view as ViewMode));
    }
    byId("empty-open").addEventListener("click", () => void this.openDialog());
    byId("find-prev").addEventListener("click", () => this.find.previous());
    byId("find-next").addEventListener("click", () => this.find.next());
    byId("find-close").addEventListener("click", () => this.find.close());

    const pane = byId("pane-preview");
    pane.addEventListener("scroll", () => this.onPreviewScroll(), { passive: true });
    for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) {
      pane.addEventListener(ev, () => this.guard.userInput("preview"), { passive: true });
    }
    byId("doc").addEventListener("click", (e) => void this.onDocClick(e));
    byId("doc").addEventListener("auxclick", (e) => {
      if ((e.target as Element).closest("a")) e.preventDefault();
    });

    window.addEventListener("keydown", (e) => this.onKey(e));
    // Any interaction counts as having looked at the latest changes.
    const looked = () => {
      this.looked = true;
    };
    window.addEventListener("focus", looked);
    for (const ev of ["pointerdown", "keydown", "wheel"]) {
      window.addEventListener(ev, looked, { capture: true, passive: true });
    }
    // Keeps relative times in the footer line current.
    setInterval(() => this.refreshFoot(), 30_000);
    window.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (this.settings.theme === "system") this.applyAppearance();
    });
    window.addEventListener("resize", () => {
      this.splitter.set(this.splitter.ratio);
      if (!this.isNarrow()) delete this.app.dataset.tocOpen;
    });
    // Links and images dragged inside the window must not navigate it.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
  }

  async bindShell(): Promise<void> {
    const { events } = await import("./ipc");
    await events.doc((e) => this.onDocEvent(e));
    await events.openFile((p) => {
      if (!MD_NAME.test(p)) toast(t("drop.notMarkdown"), "error");
      else void this.openPath(p);
    });
    await events.drag((s) => {
      const drop = byId("drop");
      drop.hidden = !s.active;
      if (s.active) {
        byId("drop-text").textContent = s.markdown ? t("drop.hint") : t("drop.notMarkdown");
        if (s.markdown) delete drop.dataset.invalid;
        else drop.dataset.invalid = "";
      }
    });
    await events.closeRequested(() => void this.onCloseRequested());
    await events.menu((id) => this.onMenu(id));
  }

  // ---------------------------------------------------------- documents

  private async confirmUnsaved(): Promise<boolean> {
    await this.settle();
    if (!this.doc || !isDirty(this.doc)) return true;
    const choice = await ask({
      title: t("dialog.unsaved.title", { name: this.doc.file.name }),
      body: t("dialog.unsaved.body"),
      buttons: [
        { id: "discard", label: t("dialog.dontSave"), apart: true },
        { id: "cancel", label: t("dialog.cancel") },
        { id: "save", label: t("dialog.save"), kind: "primary" },
      ],
      defaultId: "save",
      cancelId: "cancel",
    });
    if (choice === "cancel") return false;
    // Typing can go on while the file is written; that text is asked about too.
    if (choice === "save") return (await this.save()) && this.confirmUnsaved();
    return true;
  }

  async openDialog(): Promise<void> {
    try {
      const path = await ipc.pickOpenFile();
      if (path) await this.openPath(path);
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  /**
   * Opens a file in a new tab next to the active one; a file that is open
   * already only gets its tab shown. `background` opens without showing it.
   */
  async openPath(
    path: string,
    opts: {
      background?: boolean;
      line?: number;
      quietMissing?: boolean;
      fragment?: string | null;
    } = {},
  ): Promise<boolean> {
    await this.settle();
    const existing = this.tabs[findTab(this.tabPaths(), path)];
    if (existing) {
      if (!opts.background) await this.activate(existing, opts.fragment ?? null);
      return true;
    }
    let opened: Awaited<ReturnType<typeof ipc.openDocument>>;
    try {
      opened = await ipc.openDocument(path);
    } catch (e) {
      if (opts.quietMissing && isCmdError(e) && e.code === "not-found") return false;
      toast(errorText(e), "error");
      return false;
    }
    // The shell spells paths one way; the same file may be open under another spelling.
    const same = this.tabs[findTab(this.tabPaths(), opened.path)];
    if (same) {
      void ipc.closeDocument(opened.sessionId);
      if (!opts.background) await this.activate(same, opts.fragment ?? null);
      return true;
    }
    const version: DiskVersion = {
      text: opened.text,
      token: opened.token,
      bom: opened.bom,
      eol: opened.eol,
      mixedEol: opened.mixedEol,
    };
    const tab: Tab = {
      doc: openDoc(
        { sessionId: opened.sessionId, path: opened.path, name: opened.name, dir: opened.dir },
        version,
      ),
      watchError: opened.watchError,
      footLeft: null,
      conflictWhere: "",
      editorState: null,
      line: opts.line ?? 1,
      marks: null,
      seen: null,
      changedAt: null,
      warned: false,
    };
    const at =
      this.active && !opts.background ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    this.closed.forget(opened.path);
    this.lastMissing = null;
    this.session.recent = addRecent(this.session.recent, opened.path);
    if (opts.background) this.renderTabs();
    else await this.activate(tab, opts.fragment ?? null);
    this.persistSession();
    return true;
  }

  private tabPaths(): string[] {
    return this.tabs.map((t) => t.doc.file.path);
  }

  /** Keeps what the reader sees of the active tab, before another one is shown. */
  private stashActive(): void {
    const tab = this.active;
    if (!tab || this.app.dataset.empty !== undefined) return;
    tab.line = this.currentLine();
    tab.editorState = this.editor?.snapshot() ?? tab.editorState;
    tab.marks = this.preview.keepMarks();
    tab.seen = this.preview.keys();
  }

  /** Shows a tab: its text, reading position, undo history and change marks. */
  private async activate(tab: Tab, fragment: string | null = null): Promise<void> {
    if (tab !== this.active) {
      this.stashActive();
      this.active = tab;
      void ipc.setActive(tab.doc.file.sessionId);
      hideToast();
      this.find.close();
      delete this.app.dataset.empty;
      byId("empty").hidden = true;
      this.editor?.load(tab.editorState, tab.doc.buffer);
      this.preview.clear();
      this.renderTabs();
      this.refreshChrome();
      try {
        const res = await this.preview.show(tab.doc.buffer, { reset: true, line: tab.line });
        if (res && this.active === tab) {
          this.toc.set(res.headings);
          this.preview.restoreMarks(tab.marks, tab.seen, tab.changedAt);
          if (tab.changedAt !== null) this.noteUpdate(res);
          tab.changedAt = null;
          tab.marks = null;
          this.trackSection();
        }
      } catch (e) {
        toast(errorText(e), "error");
      }
      if (this.active !== tab) return;
      if (this.view() !== "preview" && this.editor) this.editor.scrollToLine(tab.line);
      if (tab.watchError && !tab.warned) {
        tab.warned = true;
        toast(t("watch.off", { reason: tab.watchError }), "error");
      }
      this.renderTabs();
      this.refreshChrome();
      this.persistSession();
      void ipc.perfMark("doc-shown", String(this.preview.blockCount));
    }
    if (fragment) this.goToAnchor(fragment);
  }

  /** Closes a tab, asking first about unsaved changes; false if the reader cancelled. */
  private async closeTab(tab: Tab): Promise<boolean> {
    await this.settle();
    if (!this.tabs.includes(tab)) return true;
    if (isDirty(tab.doc)) {
      if (tab !== this.active) await this.activate(tab);
      if (!(await this.confirmUnsaved())) return false;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    const wasActive = tab === this.active;
    const shown = this.active ? this.tabs.indexOf(this.active) : i;
    const next = activeAfterClose(this.tabs.length, i, shown);
    this.closed.push(tab.doc.file.path);
    this.tabs.splice(i, 1);
    void ipc.closeDocument(tab.doc.file.sessionId);
    if (wasActive) {
      this.active = null;
      const show = this.tabs[next];
      if (show) await this.activate(show);
      else {
        this.preview.clear();
        this.showEmpty();
      }
    }
    this.renderTabs();
    this.persistSession();
    return true;
  }

  private async closeTabs(kind: CloseKind, at: number): Promise<void> {
    const targets = toClose(kind, this.tabs.length, at).map((i) => this.tabs[i]);
    for (const tab of targets) {
      if (tab && !(await this.closeTab(tab))) return;
    }
  }

  private async reopenClosed(): Promise<void> {
    const path = this.closed.pop();
    if (path) await this.openPath(path);
  }

  private cycleTab(dir: 1 | -1): void {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    const next = this.tabs[(i + dir + this.tabs.length) % this.tabs.length];
    if (next) void this.activate(next);
  }

  private openTabMenu(i: number, anchor: HTMLElement): void {
    const tab = this.tabs[i];
    if (!tab) return;
    const n = this.tabs.length;
    const reveal =
      this.platform === "macos"
        ? t("tabs.revealMac")
        : this.platform === "windows"
          ? t("tabs.revealWin")
          : t("tabs.revealLinux");
    const copyPath = () => {
      void navigator.clipboard.writeText(this.showPath(tab.doc.file.path)).catch(() => {});
    };
    const revealIt = () => {
      void ipc.revealDocument(tab.doc.file.sessionId).catch((e) => toast(errorText(e), "error"));
    };
    openMenu(anchor, [
      {
        label: t("tabs.close"),
        shortcut: this.keyLabel("Mod+W"),
        action: () => void this.closeTab(tab),
      },
      {
        label: t("tabs.closeOthers"),
        disabled: n < 2,
        action: () => void this.closeTabs("others", i),
      },
      {
        label: t("tabs.closeRight"),
        disabled: i >= n - 1,
        action: () => void this.closeTabs("right", i),
      },
      { label: t("tabs.closeAll"), action: () => void this.closeTabs("all", i) },
      "separator",
      { label: t("tabs.copyPath"), action: copyPath },
      { label: reveal, action: revealIt },
      "separator",
      {
        label: t("tabs.reopen"),
        shortcut: this.keyLabel("Mod+Shift+T"),
        disabled: !this.closed.has(),
        action: () => void this.reopenClosed(),
      },
    ]);
  }

  private tabState(tab: Tab): TabState {
    const d = tab.doc;
    if (d.disk === "missing") return "missing";
    if (d.disk === "error") return "error";
    if (d.pending) return "conflict";
    if (isDirty(d)) return "unsaved";
    if (tab.changedAt !== null) return "changed";
    return "current";
  }

  private renderTabs(): void {
    this.tabBar.render(
      this.tabs.map((tab) => ({
        name: tab.doc.file.name,
        path: this.showPath(tab.doc.file.path),
        state: this.tabState(tab),
        active: tab === this.active,
      })),
    );
  }

  private showEmpty(): void {
    this.app.dataset.empty = "";
    this.toc.set([]);
    byId("head-section").replaceChildren();
    byId("empty").hidden = false;
    const notice = byId("empty-notice");
    notice.hidden = !this.lastMissing;
    if (this.lastMissing) {
      byId("empty-notice-text").textContent = t("empty.lastMissing", {
        path: this.showPath(this.lastMissing),
      });
    }
    const recent = this.session.recent;
    byId("empty-recent").hidden = recent.length === 0;
    byId("empty-recent-list").replaceChildren(
      ...recent.slice(0, 8).map((p) => {
        const shown = this.showPath(p);
        const sep = Math.max(shown.lastIndexOf("/"), shown.lastIndexOf("\\"));
        const btn = h(
          "button",
          { type: "button" },
          h("span", { class: "name" }, shown.slice(sep + 1)),
          h("span", { class: "dir" }, shown.slice(0, Math.max(0, sep))),
        );
        btn.addEventListener("click", () => void this.openPath(p));
        return h("li", {}, btn);
      }),
    );
    this.refreshChrome();
  }

  private onEdited(text: string): void {
    if (!this.doc) return;
    const wasDirty = isDirty(this.doc);
    this.doc = reduce(this.doc, { type: "edited", text });
    if (wasDirty !== isDirty(this.doc)) this.refreshChrome();
    else this.refreshFoot();
    clearTimeout(this.renderTimer);
    const delay = Math.min(800, Math.max(90, 60 + this.preview.lastMs * 2));
    this.renderTimer = setTimeout(() => void this.renderBuffer(), delay);
  }

  private async renderBuffer(
    opts: { external?: boolean; accumulate?: boolean } = {},
  ): Promise<ShowResult | null> {
    if (!this.doc) return null;
    let res: ShowResult | null = null;
    try {
      res = await this.preview.show(this.doc.buffer, opts);
    } catch (e) {
      toast(errorText(e), "error");
    }
    if (res) {
      this.toc.set(res.headings);
      if (this.view() === "split" && this.editor && !opts.external) {
        // While typing, keep the preview at the editor's position.
        if (this.guard.shouldSync("editor")) {
          this.preview.pane.scrollTop = this.preview.offsetForLine(this.editor.topLine());
          this.guard.programmatic("preview");
        }
      }
      this.trackSection();
    }
    return res;
  }

  private onDocEvent(e: DocEvent): void {
    const tab = this.tabs.find((x) => x.doc.file.sessionId === e.sessionId);
    if (!tab) return;
    if (tab !== this.active || this.app.dataset.empty !== undefined) {
      this.onBackgroundEvent(tab, e);
      return;
    }
    if (!this.doc) return;
    const before = this.doc;
    if (e.kind === "changed" && e.text !== undefined && e.token) {
      this.doc = reduce(this.doc, {
        type: "external",
        seq: e.seq,
        version: {
          text: e.text,
          token: e.token,
          bom: e.bom ?? false,
          eol: e.eol ?? "lf",
          mixedEol: e.mixedEol ?? false,
        },
        at: Date.now(),
      });
      if (this.doc.buffer !== before.buffer) {
        this.editor?.setText(this.doc.buffer, true);
        const accumulate = !this.looked;
        this.looked = false;
        void this.renderBuffer({ external: true, accumulate }).then((res) => {
          void ipc.perfMark("external-applied", e.token);
          if (res && this.doc) this.noteUpdate(res);
        });
      } else if (this.doc.pending && this.doc.pending !== before.pending) {
        this.conflictWhere = this.describeChange(this.doc.base.text, this.doc.pending.text);
        this.footLeft = { kind: "conflict", at: Date.now(), where: this.conflictWhere };
      }
    } else if (e.kind === "missing") {
      this.doc = reduce(this.doc, { type: "missing", seq: e.seq });
    } else if (e.kind === "error" && e.problem) {
      this.doc = reduce(this.doc, { type: "readError", seq: e.seq, problem: e.problem });
    }
    this.refreshChrome();
    this.renderTabs();
  }

  /** A file changed while its tab is not on screen: keep the state, mark the tab. */
  private onBackgroundEvent(tab: Tab, e: DocEvent): void {
    const before = tab.doc;
    if (e.kind === "changed" && e.text !== undefined && e.token) {
      tab.doc = reduce(tab.doc, {
        type: "external",
        seq: e.seq,
        version: {
          text: e.text,
          token: e.token,
          bom: e.bom ?? false,
          eol: e.eol ?? "lf",
          mixedEol: e.mixedEol ?? false,
        },
        at: Date.now(),
      });
      if (tab.doc.buffer !== before.buffer) {
        tab.changedAt = Date.now();
      } else if (tab.doc.pending && tab.doc.pending !== before.pending) {
        tab.conflictWhere = this.describeChange(tab.doc.base.text, tab.doc.pending.text);
        tab.footLeft = { kind: "conflict", at: Date.now(), where: tab.conflictWhere };
      }
    } else if (e.kind === "missing") {
      tab.doc = reduce(tab.doc, { type: "missing", seq: e.seq });
    } else if (e.kind === "error" && e.problem) {
      tab.doc = reduce(tab.doc, { type: "readError", seq: e.seq, problem: e.problem });
    }
    this.renderTabs();
  }

  private noteUpdate(res: ShowResult): void {
    const info = this.preview.markInfo();
    const entries = this.toc.entries;
    const sectionOf = (line: number) => {
      let found: TocEntry | undefined;
      for (const e of entries) {
        if (e.line <= line) found = e;
        else break;
      }
      return found;
    };
    const sections: TocEntry[] = [];
    for (const line of info.lines) {
      const s = sectionOf(line);
      if (s && !sections.includes(s)) sections.push(s);
    }
    this.toc.markChanged(new Set(sections.map((s) => s.id)));
    const now = Date.now();
    this.footLeft = {
      kind: "updated",
      at: now,
      since: info.since !== null && now - info.since > 1500 ? info.since : null,
      count: info.count,
      removed: info.count === 0 && res.stats.removed > 0,
      sections,
    };
    this.refreshFoot();
  }

  /** "lines 40–52 in 2.1 Goals" for a disk change the user has not loaded. */
  private describeChange(oldText: string, newText: string): string {
    const c = summarizeChange(oldText, newText);
    if (!c) return "";
    const lines =
      c.to < c.from
        ? t("conflict.removedAt", { line: c.from })
        : c.to === c.from
          ? t("conflict.line", { line: c.from })
          : t("conflict.lines", { from: c.from, to: c.to });
    const names = c.sections.slice(0, 3).join(", ");
    return names ? `${lines} ${t("foot.changedIn", { section: names })}` : lines;
  }

  private stepChange(dir: 1 | -1): void {
    if (this.view() === "source") {
      const lines = this.preview.markInfo().lines;
      const cur = this.editor?.topLine() ?? 1;
      const next =
        dir === 1 ? lines.find((l) => l > cur + 1) : [...lines].reverse().find((l) => l < cur - 1);
      if (next !== undefined) this.editor?.revealLine(next);
      return;
    }
    if (this.preview.stepMark(dir) !== null) {
      this.guard.userInput("preview");
      this.onPreviewScroll();
    }
  }

  /** Paths with the platform's own separator, also for entries stored earlier. */
  private showPath(p: string): string {
    return this.platform === "windows" ? p.replace(/\//g, "\\") : p;
  }

  private keyLabel(combo: string): string {
    return shortcutLabel(this.platform, combo, language());
  }

  // --------------------------------------------------------------- saving

  async save(): Promise<boolean> {
    if (!this.doc || this.saving) return false;
    if (hasConflict(this.doc) && !(await this.confirmOverwrite())) return false;
    return this.writeDoc(hasConflict(this.doc ?? ({} as DocState)));
  }

  /** Registers a running save so that opening and closing can wait for it. */
  private track(job: Promise<boolean>): Promise<boolean> {
    this.saveJob = job;
    const done = () => {
      if (this.saveJob === job) this.saveJob = null;
    };
    job.then(done, done);
    return job;
  }

  /** Waits until no save is running, so the document state is final. */
  private async settle(): Promise<void> {
    while (this.saveJob) {
      try {
        await this.saveJob;
      } catch {
        // The save reported its own error.
      }
    }
  }

  private async confirmOverwrite(): Promise<boolean> {
    if (!this.doc) return false;
    const choice = await ask({
      title: t("dialog.overwrite.title"),
      body: t("dialog.overwrite.body", { name: this.doc.file.name }),
      buttons: [
        { id: "saveAs", label: t("dialog.overwrite.saveAs"), apart: true },
        { id: "cancel", label: t("dialog.cancel") },
        { id: "replace", label: t("dialog.overwrite.confirm"), kind: "danger" },
      ],
      defaultId: "cancel",
      cancelId: "cancel",
    });
    if (choice === "saveAs") {
      await this.saveAs();
      return false;
    }
    return choice === "replace";
  }

  private writeDoc(force: boolean): Promise<boolean> {
    return this.track(this.writeDocOnce(force));
  }

  /** The tab still shows the document a save was started for. */
  private stillOpen(tab: Tab, sessionId: number): boolean {
    return this.tabs.includes(tab) && tab.doc.file.sessionId === sessionId;
  }

  /** After a save: the tab's marks no longer mean anything. */
  private afterSave(tab: Tab): void {
    tab.footLeft = { kind: "saved", at: Date.now() };
    tab.marks = null;
    tab.changedAt = null;
    if (tab === this.active) {
      this.preview.clearMarks();
      this.toc.markChanged(new Set());
    }
  }

  private async writeDocOnce(force: boolean): Promise<boolean> {
    const tab = this.active;
    if (!tab) return false;
    // The answer belongs to this tab, even if another one is on screen by then.
    const sessionId = tab.doc.file.sessionId;
    const text = tab.doc.buffer;
    const base = tab.doc.base;
    this.saving = true;
    this.refreshChrome();
    try {
      const saved = await ipc.save({
        sessionId,
        text,
        bom: base.bom,
        eol: base.eol,
        expectedToken: base.token,
        force,
        targetPath: null,
      });
      if (!this.stillOpen(tab, sessionId)) return false;
      tab.doc = reduce(tab.doc, { type: "saved", text, token: saved.token, at: Date.now() });
      this.afterSave(tab);
      return true;
    } catch (e) {
      if (isCmdError(e) && e.code === "conflict" && !force) {
        this.saving = false;
        const shown = this.active === tab && this.stillOpen(tab, sessionId);
        if (shown && (await this.confirmOverwrite())) return this.writeDocOnce(true);
        return false;
      }
      if (!this.stillOpen(tab, sessionId)) return false;
      toast(errorText(e), "error");
      return false;
    } finally {
      this.saving = false;
      this.refreshChrome();
      this.renderTabs();
    }
  }

  async saveAs(): Promise<boolean> {
    if (!this.doc || this.saving) return false;
    return this.track(this.saveAsOnce());
  }

  private async saveAsOnce(): Promise<boolean> {
    const tab = this.active;
    if (!tab) return false;
    const sessionId = tab.doc.file.sessionId;
    let target: string | null;
    try {
      target = await ipc.pickSavePath(tab.doc.file.name);
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    }
    if (!target || !this.stillOpen(tab, sessionId)) return false;
    const text = tab.doc.buffer;
    const base = tab.doc.base;
    this.saving = true;
    this.refreshChrome();
    try {
      const saved = await ipc.save({
        sessionId,
        text,
        bom: base.bom,
        eol: base.eol,
        expectedToken: null,
        force: true,
        targetPath: target,
      });
      if (this.stillOpen(tab, sessionId)) {
        tab.doc = reduce(tab.doc, {
          type: "savedAs",
          text,
          token: saved.token,
          at: Date.now(),
          file: { sessionId: saved.sessionId, path: saved.path, name: saved.name, dir: saved.dir },
        });
        this.afterSave(tab);
        this.session.recent = addRecent(this.session.recent, saved.path);
        this.persistSession();
      }
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    } finally {
      this.saving = false;
      this.refreshChrome();
      this.renderTabs();
    }
  }

  private async discardMine(): Promise<void> {
    if (!this.doc?.pending) return;
    const choice = await ask({
      title: t("dialog.discard.title"),
      body: t("dialog.discard.body"),
      buttons: [
        { id: "cancel", label: t("dialog.cancel") },
        { id: "discard", label: t("dialog.discard.confirm"), kind: "danger" },
      ],
      defaultId: "cancel",
      cancelId: "cancel",
    });
    if (choice !== "discard" || !this.doc?.pending) return;
    this.doc = reduce(this.doc, { type: "discardMine" });
    this.conflictWhere = "";
    this.editor?.setText(this.doc.buffer, true);
    this.refreshChrome();
    const res = await this.renderBuffer({ external: true });
    if (res) this.noteUpdate(res);
  }

  private async onCloseRequested(): Promise<void> {
    await ipc.closeAck();
    if (isDialogOpen()) return;
    // Every tab with unsaved changes is shown and asked about in turn.
    for (const tab of [...this.tabs]) {
      if (!this.tabs.includes(tab) || !isDirty(tab.doc)) continue;
      await this.activate(tab);
      if (!(await this.confirmUnsaved())) return;
    }
    const decided = this.doc?.buffer;
    this.rememberPosition();
    clearTimeout(this.sessionTimer);
    clearTimeout(this.settingsTimer);
    try {
      await Promise.all([ipc.saveSession(this.sessionToStore()), ipc.saveSettings(this.settings)]);
    } catch {
      // Losing the session is acceptable; the document was handled above.
    }
    // Text typed after the decision above is asked about before the window goes.
    if (this.doc && this.doc.buffer !== decided && !(await this.confirmUnsaved())) return;
    await ipc.confirmClose();
  }

  // ---------------------------------------------------------------- links

  private async onDocClick(e: MouseEvent): Promise<void> {
    const target = e.target as Element;
    const action = target.closest<HTMLElement>("[data-action]");
    if (action) {
      e.preventDefault();
      await this.onDocAction(action);
      return;
    }
    const a = target.closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href");
    if (!href) return;
    const link = classifyHref(href);
    try {
      switch (link.kind) {
        case "anchor":
          this.goToAnchor(link.id);
          break;
        case "external":
          await ipc.openExternal(link.url);
          break;
        case "doc": {
          if (!this.doc) break;
          const path = await ipc.resolveLink(this.doc.file.sessionId, link.path);
          if (path === this.doc.file.path) {
            if (link.fragment) this.goToAnchor(link.fragment);
          } else {
            await this.openPath(path, { fragment: link.fragment });
          }
          break;
        }
        case "blocked":
          break;
      }
    } catch (err) {
      toast(
        isCmdError(err) && err.code === "not-found" ? t("link.notFound") : errorText(err),
        "error",
      );
    }
  }

  private goToAnchor(fragment: string): void {
    const ids = [`h-${fragment}`, `h-${fragment.toLowerCase()}`];
    const heading = this.preview.headings.find((x) => ids.includes(x.id));
    if (this.view() === "source" && heading) {
      this.editor?.revealLine(heading.line);
      return;
    }
    for (const id of ids) {
      if (this.preview.scrollToHeading(id)) {
        this.guard.userInput("preview");
        this.onPreviewScroll();
        return;
      }
    }
    toast(t("anchor.notFound", { id: fragment }), "error");
  }

  private async onDocAction(el: HTMLElement): Promise<void> {
    switch (el.dataset.action) {
      case "copy": {
        const code = el.closest(".code-block")?.querySelector("pre")?.textContent ?? "";
        try {
          await navigator.clipboard.writeText(code);
        } catch {
          return;
        }
        const label = el.querySelector("span");
        el.dataset.done = "";
        if (label) label.textContent = t("code.copied");
        setTimeout(() => {
          delete el.dataset.done;
          if (label) label.textContent = t("code.copy");
        }, 1500);
        break;
      }
      case "allow-external":
        if (this.doc) await ipc.setExternalImages(this.doc.file.sessionId, true);
        await this.renderBuffer();
        break;
      case "allow-folder":
        if (el.dataset.dir) {
          try {
            if (this.doc) await ipc.grantFolder(this.doc.file.sessionId, el.dataset.dir);
            await this.renderBuffer();
          } catch (e) {
            toast(errorText(e), "error");
          }
        }
        break;
      case "toggle-source": {
        const { toggleSource } = await import("./preview/mermaid");
        toggleSource(el);
        break;
      }
    }
  }

  // ---------------------------------------------------------------- views

  private view(): ViewMode {
    return (this.app.dataset.view as ViewMode) ?? "preview";
  }

  private setViewAttr(v: ViewMode): void {
    this.app.dataset.view = v;
    for (const b of byId("views").querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.view === v));
    }
  }

  private async ensureEditor(): Promise<Editor> {
    if (this.editor) return this.editor;
    this.editorLoading ??= import("./editor/editor").then(({ Editor }) => {
      const ed = new Editor(
        byId("pane-editor"),
        this.doc?.buffer ?? "",
        {
          onChange: (text) => this.onEdited(text),
          onScroll: () => this.onEditorScroll(),
          onUserInput: () => this.guard.userInput("editor"),
        },
        t("editor.label"),
      );
      this.editor = ed;
      return ed;
    });
    return this.editorLoading;
  }

  async setView(v: ViewMode): Promise<void> {
    if (!this.doc) return;
    const before = this.view();
    const line =
      before === "source" && this.editor ? this.editor.topLine() : this.preview.topLine();
    if (v !== "preview") {
      const ed = await this.ensureEditor();
      if (this.doc && ed.text !== this.doc.buffer) ed.setText(this.doc.buffer, false);
    }
    this.find.close();
    this.setViewAttr(v);
    this.session.view = v;
    this.persistSession();
    requestAnimationFrame(() => {
      if (v !== "preview" && this.editor) {
        this.editor.scrollToLine(line);
        this.guard.programmatic("editor");
      }
      if (v !== "source") {
        this.preview.invalidateGeometry();
        this.preview.pane.scrollTop = this.preview.offsetForLine(line);
        this.guard.programmatic("preview");
      }
      if (v === "preview") this.preview.pane.focus({ preventScroll: true });
      else if (before === "preview") this.editor?.focus();
      this.trackSection();
    });
  }

  private onPreviewScroll(): void {
    if (this.view() === "split" && this.editor && this.guard.shouldSync("preview")) {
      this.editor.scrollToLine(this.preview.topLine());
      this.guard.programmatic("editor");
    }
    this.scheduleSectionTrack();
    this.scheduleRememberPosition();
  }

  private onEditorScroll(): void {
    if (this.view() === "split" && this.editor && this.guard.shouldSync("editor")) {
      this.preview.pane.scrollTop = this.preview.offsetForLine(this.editor.topLine());
      this.guard.programmatic("preview");
    }
    this.scheduleSectionTrack();
    this.scheduleRememberPosition();
  }

  private sectionFrame = 0;
  private scheduleSectionTrack(): void {
    if (this.sectionFrame) return;
    this.sectionFrame = requestAnimationFrame(() => {
      this.sectionFrame = 0;
      this.trackSection();
    });
  }

  private trackSection(): void {
    let index = -1;
    if (this.view() === "source" && this.editor) {
      const line = this.editor.topLine();
      this.toc.entries.forEach((e, i) => {
        if (e.line <= line + 0.5) index = i;
      });
    } else {
      index = this.preview.currentHeading();
    }
    this.toc.mark(index);
    const entry = this.toc.entry(index);
    const head = byId("head-section");
    head.replaceChildren(
      ...(entry
        ? [h("span", { class: "num" }, entry.number), h("span", { class: "title" }, entry.text)]
        : []),
    );
  }

  private toggleToc(): void {
    if (this.isNarrow()) {
      if (this.app.dataset.tocOpen !== undefined) delete this.app.dataset.tocOpen;
      else {
        this.app.dataset.toc = "on";
        this.app.dataset.tocOpen = "";
      }
      return;
    }
    const on = this.app.dataset.toc !== "on";
    this.app.dataset.toc = on ? "on" : "off";
    this.session.toc = on;
    this.persistSession();
    requestAnimationFrame(() => this.preview.invalidateGeometry());
  }

  /** Contents shows as an overlay: narrow windows, or split view below 1200px. */
  private isNarrow(): boolean {
    return (
      window.matchMedia("(max-width: 760px)").matches ||
      (this.view() === "split" && window.matchMedia("(max-width: 1199px)").matches)
    );
  }

  // ----------------------------------------------------------- appearance

  private resolvedTheme(): "mocha" | "latte" {
    if (this.settings.theme !== "system") return this.settings.theme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "mocha" : "latte";
  }

  private applyAppearance(): void {
    const root = document.documentElement;
    const theme = this.resolvedTheme();
    const changed = root.dataset.theme !== theme;
    root.dataset.theme = theme;
    root.dataset.font = this.settings.font;
    root.style.setProperty("--zoom", String(this.settings.zoom));
    void ipc.setWindowTheme(
      this.settings.theme === "system" ? null : theme === "mocha" ? "dark" : "light",
    );
    if (changed) void this.preview.refreshDiagrams();
  }

  private diagramTheme() {
    const style = getComputedStyle(document.documentElement);
    const names = [
      "base",
      "mantle",
      "crust",
      "surface0",
      "surface1",
      "surface2",
      "overlay0",
      "overlay1",
      "overlay2",
      "text",
      "subtext0",
      "subtext1",
      "blue",
    ];
    const colors: Record<string, string> = {};
    for (const n of names) colors[n] = style.getPropertyValue(`--ctp-${n}`).trim();
    return { name: this.resolvedTheme(), colors };
  }

  private applySettings(patch: Partial<Settings>): void {
    const lang = patch.language;
    this.settings = { ...this.settings, ...patch };
    if (lang && lang !== language()) setLanguage(lang);
    if (patch.marks === false) this.preview.clearMarks();
    if (patch.zoom !== undefined) this.applyZoom(patch.zoom);
    this.applyAppearance();
    this.refreshFoot();
    clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(
      () => void ipc.saveSettings(this.settings).catch(() => {}),
      400,
    );
  }

  private applyZoom(z: number): void {
    const line = this.view() === "source" ? null : this.preview.topLine();
    this.settings.zoom = clampZoom(z);
    document.documentElement.style.setProperty("--zoom", String(this.settings.zoom));
    requestAnimationFrame(() => {
      this.preview.invalidateGeometry();
      if (line !== null && this.doc) this.preview.pane.scrollTop = this.preview.offsetForLine(line);
      this.editor?.view.requestMeasure();
    });
  }

  private zoomBy(steps: number): void {
    this.applySettings({ zoom: clampZoom(this.settings.zoom + steps * ZOOM_STEP) });
  }

  // ------------------------------------------------------------ keyboard

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const action = shortcutFor(e, this.platform);
    if (!action) return;
    if (isDialogOpen() && action !== "escape") return;
    if (menuOwnsShortcut(action, this.platform)) return;
    if (this.run(action)) e.preventDefault();
  }

  private onMenu(id: string): void {
    const map: Record<string, Action> = {
      open: "open",
      save: "save",
      "save-as": "saveAs",
      find: "find",
      "view-preview": "viewPreview",
      "view-split": "viewSplit",
      "view-source": "viewSource",
      contents: "toggleToc",
      "zoom-in": "zoomIn",
      "zoom-out": "zoomOut",
      "zoom-reset": "zoomReset",
      settings: "settings",
      "close-tab": "closeTab",
      "reopen-tab": "reopenTab",
    };
    const action = map[id];
    if (action && !isDialogOpen()) this.run(action);
  }

  private run(action: Action): boolean {
    switch (action) {
      case "open":
        void this.openDialog();
        return true;
      case "save":
        if (this.doc) void this.save();
        return true;
      case "saveAs":
        if (this.doc) void this.saveAs();
        return true;
      case "find":
        if (this.doc) this.find.open(window.getSelection()?.toString() ?? "");
        return true;
      case "escape":
        if (isMenuOpen()) closeMenu();
        else if (this.find.isOpen) this.find.close();
        else if (isToastOpen()) hideToast();
        else if (this.app.dataset.tocOpen !== undefined) delete this.app.dataset.tocOpen;
        else return false;
        return true;
      case "zoomIn":
        this.zoomBy(1);
        return true;
      case "zoomOut":
        this.zoomBy(-1);
        return true;
      case "zoomReset":
        this.applySettings({ zoom: 1 });
        return true;
      case "viewPreview":
        void this.setView("preview");
        return true;
      case "viewSplit":
        void this.setView("split");
        return true;
      case "viewSource":
        void this.setView("source");
        return true;
      case "toggleToc":
        this.toggleToc();
        return true;
      case "settings":
        this.showSettings();
        return true;
      case "nextChange":
        this.stepChange(1);
        return true;
      case "prevChange":
        this.stepChange(-1);
        return true;
      case "closeTab":
        if (this.active) void this.closeTab(this.active);
        return true;
      case "reopenTab":
        void this.reopenClosed();
        return true;
      case "nextTab":
        this.cycleTab(1);
        return true;
      case "prevTab":
        this.cycleTab(-1);
        return true;
    }
  }

  private onWheel(e: WheelEvent): void {
    const zoomKey = e.ctrlKey || (this.platform === "macos" && e.metaKey);
    if (!zoomKey) return;
    e.preventDefault();
    // Mouse wheels send one large step, trackpads and pinch many small ones.
    this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    if (Math.abs(this.wheelAcc) >= 50) {
      this.zoomBy(this.wheelAcc < 0 ? 1 : -1);
      this.wheelAcc = 0;
    }
  }

  // ---------------------------------------------------------------- menus

  private openFileMenu(anchor: HTMLElement): void {
    const mod = (c: string) => this.keyLabel(c);
    const recent = this.session.recent;
    const entries: MenuEntry[] = [
      { label: t("menu.open"), shortcut: mod("Mod+O"), action: () => void this.openDialog() },
      "separator",
      { group: t("menu.recent") },
    ];
    if (recent.length === 0) {
      entries.push({ label: t("menu.recentEmpty"), disabled: true, action: () => {} });
    } else {
      for (const p of recent) {
        const shown = this.showPath(p);
        const sep = Math.max(shown.lastIndexOf("/"), shown.lastIndexOf("\\"));
        entries.push({
          label: shown.slice(sep + 1),
          sub: shown.slice(0, Math.max(0, sep)),
          action: () => void this.openPath(p),
        });
      }
      entries.push({ label: t("menu.clearRecent"), action: () => this.clearRecent() });
    }
    entries.push(
      "separator",
      {
        label: t("menu.save"),
        shortcut: mod("Mod+S"),
        disabled: !this.doc,
        action: () => void this.save(),
      },
      {
        label: t("menu.saveAs"),
        shortcut: mod("Mod+Shift+S"),
        disabled: !this.doc,
        action: () => void this.saveAs(),
      },
      "separator",
      {
        label: t("menu.closeTab"),
        shortcut: mod("Mod+W"),
        disabled: !this.active,
        action: () => {
          if (this.active) void this.closeTab(this.active);
        },
      },
      {
        label: t("menu.reopenTab"),
        shortcut: mod("Mod+Shift+T"),
        disabled: !this.closed.has(),
        action: () => void this.reopenClosed(),
      },
    );
    openMenu(anchor, entries);
  }

  private openMoreMenu(anchor: HTMLElement): void {
    const mod = (c: string) => this.keyLabel(c);
    const view = this.view();
    const viewItem = (v: ViewMode, label: string, key: string): MenuEntry => ({
      label,
      shortcut: mod(key),
      checked: view === v,
      disabled: !this.doc,
      action: () => void this.setView(v),
    });
    openMenu(anchor, [
      viewItem("preview", t("view.preview"), "Mod+1"),
      viewItem("split", t("view.split"), "Mod+2"),
      viewItem("source", t("view.source"), "Mod+3"),
      "separator",
      {
        label: t("menu.contents"),
        shortcut: mod("Mod+B"),
        checked: this.app.dataset.toc === "on",
        disabled: !this.doc,
        action: () => this.toggleToc(),
      },
      {
        label: t("menu.find"),
        shortcut: mod("Mod+F"),
        disabled: !this.doc,
        action: () => this.find.open(),
      },
      {
        label: t("menu.nextChange"),
        shortcut: "F8",
        disabled: !this.doc || this.preview.markInfo().lines.length === 0,
        action: () => this.stepChange(1),
      },
      {
        label: t("menu.prevChange"),
        shortcut: mod("Shift+F8"),
        disabled: !this.doc || this.preview.markInfo().lines.length === 0,
        action: () => this.stepChange(-1),
      },
      "separator",
      { label: t("menu.zoomIn"), shortcut: mod("Mod++"), action: () => this.zoomBy(1) },
      { label: t("menu.zoomOut"), shortcut: mod("Mod+-"), action: () => this.zoomBy(-1) },
      {
        label: t("menu.zoomReset"),
        shortcut: mod("Mod+0"),
        action: () => this.applySettings({ zoom: 1 }),
      },
      "separator",
      { label: t("menu.settings"), shortcut: mod("Mod+,"), action: () => this.showSettings() },
    ]);
  }

  private showSettings(): void {
    openSettings({
      get: () => this.settings,
      apply: (patch) => this.applySettings(patch),
      zoomBy: (n) => this.zoomBy(n),
      zoomReset: () => this.applySettings({ zoom: 1 }),
      recentCount: () => this.session.recent.length,
      clearRecent: () => this.clearRecent(),
    });
  }

  private clearRecent(): void {
    this.session.recent = [];
    this.persistSession();
    if (!this.doc) this.showEmpty();
  }

  // --------------------------------------------------------------- chrome

  private refreshChrome(): void {
    const d = this.doc;
    const dirty = d ? isDirty(d) : false;
    byId("file-name").textContent = d ? d.file.name : t("head.noFile");
    byId("file-dir").textContent = d ? d.file.dir : "";
    const keys: Record<string, string> = { preview: "Mod+1", split: "Mod+2", source: "Mod+3" };
    for (const b of byId("views").querySelectorAll<HTMLButtonElement>("button")) {
      b.disabled = !d;
      b.title = `${b.textContent ?? ""} (${this.keyLabel(keys[b.dataset.view ?? ""] ?? "")})`;
    }
    void ipc.setTitle(d ? `${dirty ? "● " : ""}${d.file.name} — psy.md` : "psy.md");
    this.refreshStatus();
    this.refreshBanner();
    this.refreshFoot();
  }

  private refreshStatus(): void {
    const d = this.doc;
    const sq = byId("status-sq");
    const text = byId("status-text");
    const status = byId("status");
    status.hidden = !d;
    if (!d) return;
    let state: string;
    let label: string;
    if (this.saving) [state, label] = ["saving", t("status.saving")];
    else if (d.disk === "missing") [state, label] = ["missing", t("status.missing")];
    else if (d.disk === "error") [state, label] = ["error", t("status.error")];
    else if (d.pending) [state, label] = ["conflict", t("status.conflict")];
    else if (isDirty(d)) [state, label] = ["unsaved", t("status.unsaved")];
    else if (this.watchError) [state, label] = ["none", t("status.notWatching")];
    else [state, label] = ["current", t("status.current")];
    sq.dataset.state = state;
    text.textContent = label;
    status.title = label;
  }

  private refreshBanner(): void {
    const banner = byId("banner");
    const d = this.doc;
    const show = (state: string, message: string, actions: [string, () => void, string?][]) => {
      banner.replaceChildren(
        h(
          "div",
          { class: "banner-text", role: "alert" },
          h("i", { class: "sq", "data-state": state }),
          h("span", {}, message),
        ),
        h(
          "div",
          { class: "banner-actions" },
          ...actions.map(([label, fn, kind]) => {
            const b = h("button", { type: "button", class: `btn${kind ? ` ${kind}` : ""}` }, label);
            b.addEventListener("click", fn);
            return b;
          }),
        ),
      );
      banner.hidden = false;
    };
    if (!d) {
      banner.hidden = true;
      return;
    }
    if (d.pending && !d.conflictKept) {
      const where = this.conflictWhere ? ` (${this.conflictWhere})` : "";
      show("conflict", t("conflict.text", { where }), [
        [t("conflict.keep"), () => this.keepMine(), "btn-primary"],
        [t("conflict.saveAs"), () => void this.saveAs()],
        [t("conflict.load"), () => void this.discardMine()],
      ]);
    } else if (d.pending) {
      show("conflict", t("conflict.kept"), [
        [t("conflict.saveAs"), () => void this.saveAs()],
        [t("conflict.load"), () => void this.discardMine()],
      ]);
    } else if (d.disk === "missing") {
      show("missing", t("missing.text"), [
        [t("missing.save"), () => void this.save(), "btn-primary"],
        [t("missing.saveAs"), () => void this.saveAs()],
      ]);
    } else if (d.disk === "error" && d.problem) {
      show("error", `${errorText(d.problem)} ${t("readError.text")}`, []);
    } else {
      banner.hidden = true;
    }
  }

  private keepMine(): void {
    if (!this.doc) return;
    this.doc = reduce(this.doc, { type: "keepMine" });
    this.refreshChrome();
  }

  private refreshFoot(): void {
    const left = byId("foot-left");
    const right = byId("foot-right");
    const d = this.doc;
    const zoom = Math.round(this.settings.zoom * 100);
    if (!d) {
      left.replaceChildren();
      right.textContent = zoom === 100 ? "" : t("foot.zoom", { pct: zoom });
      return;
    }
    const f = this.footLeft;
    const when = (at: number) => {
      const age = Math.round((Date.now() - at) / 60_000);
      const rel =
        age >= 1
          ? ` (${new Intl.RelativeTimeFormat(language(), { numeric: "auto" }).format(-age, "minute")})`
          : "";
      return [h("time", {}, clock(at)), rel];
    };
    if (!f) {
      left.replaceChildren();
    } else if (f.kind === "saved") {
      left.replaceChildren(h("span", { class: "rev-word" }, t("foot.savedAt")), " ", ...when(f.at));
    } else if (f.kind === "conflict") {
      left.replaceChildren(
        h("span", { class: "rev-word" }, t("foot.changedOnDisk")),
        " ",
        ...when(f.at),
        f.where ? ` · ${f.where}` : "",
      );
    } else {
      const parts: (Node | string)[] = [
        h("span", { class: "rev-word" }, t("foot.updatedAt")),
        " ",
        ...when(f.at),
      ];
      const what = f.removed
        ? t("foot.removed")
        : f.count === 1
          ? t("foot.changedOne")
          : f.count > 1
            ? t("foot.changedMany", { n: f.count })
            : "";
      if (what) {
        parts.push(` · ${what}`);
        if (f.since) parts.push(` ${t("foot.since", { time: clock(f.since) })}`);
        if (f.sections.length) {
          parts.push(` ${t("foot.in")} `);
          f.sections.slice(0, 3).forEach((sec, i) => {
            if (i > 0) parts.push(", ");
            const b = h(
              "button",
              { type: "button", class: "foot-link", title: t("foot.jump") },
              `${sec.number ? `${sec.number} ` : ""}${sec.text}`,
            );
            const next = this.toc.entries[this.toc.entries.indexOf(sec) + 1];
            b.addEventListener("click", () => {
              if (this.view() === "source") this.editor?.revealLine(sec.line);
              else if (
                !this.preview.showMarkFrom(sec.line, next?.line ?? Number.MAX_SAFE_INTEGER)
              ) {
                this.preview.scrollToHeading(sec.id);
              }
            });
            parts.push(b);
          });
          if (f.sections.length > 3) parts.push(" …");
        }
      }
      left.replaceChildren(...parts);
    }
    const info = [
      d.base.bom ? "UTF-8 BOM" : "",
      d.base.eol === "crlf" ? "CRLF" : "",
      d.base.mixedEol ? t("foot.mixedEol") : "",
      t("foot.lines", { n: lineCount(d.buffer) }),
      zoom === 100 ? "" : t("foot.zoom", { pct: zoom }),
    ].filter(Boolean);
    right.textContent = info.join(" · ");
  }

  // ------------------------------------------------------------- session

  private persistSession(): void {
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(
      () => void ipc.saveSession(this.sessionToStore()).catch(() => {}),
      500,
    );
  }

  /** The session with the open tabs, in order, and the one on screen. */
  private sessionToStore(): Session {
    this.session.tabs = this.tabs.map((tab) => ({ path: tab.doc.file.path, line: tab.line }));
    this.session.activeTab = this.active ? this.tabs.indexOf(this.active) : -1;
    return this.session;
  }

  private rememberTimer: ReturnType<typeof setTimeout> | undefined;
  private scheduleRememberPosition(): void {
    clearTimeout(this.rememberTimer);
    this.rememberTimer = setTimeout(() => {
      this.rememberPosition();
      this.persistSession();
    }, 1200);
  }

  private rememberPosition(): void {
    if (this.active && this.app.dataset.empty === undefined) this.active.line = this.currentLine();
  }

  /** Source line at the top of the editor (in Source view) or the preview. */
  private currentLine(): number {
    const line =
      this.view() === "source" && this.editor ? this.editor.topLine() : this.preview.topLine();
    return Math.max(1, Math.floor(line));
  }
}
