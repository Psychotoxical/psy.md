// Saving, switching and closing tabs while a write is still running.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { type DocState, isDirty, openDoc, reduce } from "./doc/model";
import { ipc, type SavedDoc } from "./ipc";
import { ClosedTabs } from "./tabs/tabs";
import { ask } from "./ui/dialog";

vi.mock("./ipc", () => ({
  ipc: {
    save: vi.fn(),
    openDocument: vi.fn(),
    pickSavePath: vi.fn(),
    closeDocument: vi.fn(),
    setActive: vi.fn(),
  },
  isCmdError: () => false,
}));
vi.mock("./ui/dialog", () => ({ ask: vi.fn(), isDialogOpen: () => false }));

function doc(id: number, text: string): DocState {
  return openDoc(
    { sessionId: id, path: `doc-${id}.md`, name: `doc-${id}.md`, dir: "." },
    { text, token: `t${id}`, bom: false, eol: "lf", mixedEol: false },
  );
}

function edited(id: number, text: string): DocState {
  return reduce(doc(id, "base"), { type: "edited", text });
}

function tab(d: DocState) {
  return {
    doc: d,
    watchError: null,
    footLeft: null,
    conflictWhere: "",
    editorState: null,
    line: 1,
    marks: null,
    seen: null,
    changedAt: null,
    warned: false,
  };
}

function savedDoc(id: number, token: string, path = `doc-${id}.md`): SavedDoc {
  return { sessionId: id, token, path, name: path, dir: "." };
}

// The controller without its window: only what saving and switching touch.
// biome-ignore lint/suspicious/noExplicitAny: test access to private members
function controller(...docs: DocState[]): any {
  const a = Object.create(App.prototype);
  const tabs = docs.map(tab);
  Object.assign(a, {
    tabs,
    active: tabs[0] ?? null,
    closed: new ClosedTabs(),
    saving: false,
    saveJob: null,
    session: { tabs: [], activeTab: -1, recent: [] },
    refreshChrome: () => {},
    renderTabs: () => {},
    persistSession: () => {},
    preview: { clearMarks: () => {} },
    toc: { markChanged: () => {} },
  });
  return a;
}

function pending<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const fn of Object.values(ipc)) vi.mocked(fn).mockReset();
  vi.mocked(ask).mockReset();
});

describe("saving while tabs change", () => {
  it("sends the session of the tab being saved", async () => {
    const a = controller(edited(1, "first"));
    vi.mocked(ipc.save).mockResolvedValue(savedDoc(1, "saved"));
    await a.writeDoc(false);
    expect(vi.mocked(ipc.save).mock.calls[0]?.[0].sessionId).toBe(1);
  });

  it("applies a save answer to its own tab while another tab is on screen", async () => {
    const a = controller(edited(1, "first"), doc(2, "second file"));
    const [first, second] = a.tabs;
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    const saving = a.writeDoc(false);
    a.active = second;
    save.resolve(savedDoc(1, "saved-1"));
    await saving;
    expect(first.doc.base.text).toBe("first");
    expect(first.doc.base.token).toBe("saved-1");
    expect(isDirty(first.doc)).toBe(false);
    expect(second.doc.base.token).toBe("t2");
  });

  it("ignores a save answer for a tab that was closed meanwhile", async () => {
    const a = controller(edited(1, "first"), doc(2, "second file"));
    const [first, second] = a.tabs;
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    const saving = a.writeDoc(false);
    a.tabs = [second];
    a.active = second;
    save.resolve(savedDoc(1, "saved-1"));
    expect(await saving).toBe(false);
    expect(first.doc.base.token).toBe("t1");
  });

  it("moves only its own tab to the target of a save as", async () => {
    const a = controller(doc(1, "clean"), doc(2, "second file"));
    const [first, second] = a.tabs;
    vi.mocked(ipc.pickSavePath).mockResolvedValue("copy.md");
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    const saving = a.saveAs();
    await tick();
    a.active = second;
    save.resolve(savedDoc(3, "saved-copy", "copy.md"));
    await saving;
    expect(first.doc.file.path).toBe("copy.md");
    expect(first.doc.file.sessionId).toBe(3);
    expect(second.doc.file.path).toBe("doc-2.md");
  });

  it("opens another file only after a running save has finished", async () => {
    const a = controller(edited(1, "first"));
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    vi.mocked(ipc.openDocument).mockReturnValue(new Promise(() => {}));
    void a.save();
    await tick();
    void a.openPath("other.md");
    await tick();
    expect(ipc.openDocument).not.toHaveBeenCalled();
    save.resolve(savedDoc(1, "saved"));
    await tick();
    await tick();
    expect(ipc.openDocument).toHaveBeenCalledWith("other.md");
  });

  it("shows the tab of a file that is open already instead of opening it twice", async () => {
    const a = controller(doc(1, "one"), doc(2, "two"));
    const shown: unknown[] = [];
    a.activate = async (t: unknown) => {
      shown.push(t);
    };
    await a.openPath("DOC-2.md".toLowerCase());
    expect(ipc.openDocument).not.toHaveBeenCalled();
    expect(shown).toEqual([a.tabs[1]]);
  });

  it("asks again before closing when typing went on during the save", async () => {
    const a = controller(edited(1, "first"));
    vi.mocked(ask).mockResolvedValueOnce("save").mockResolvedValueOnce("cancel");
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    const released = a.confirmUnsaved();
    await tick();
    a.active.doc = reduce(a.active.doc, { type: "edited", text: "typed while saving" });
    save.resolve(savedDoc(1, "saved"));
    expect(await released).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(a.doc.buffer).toBe("typed while saving");
    expect(isDirty(a.doc)).toBe(true);
  });

  it("releases the document after a save when nothing was typed meanwhile", async () => {
    const a = controller(edited(1, "first"));
    vi.mocked(ask).mockResolvedValueOnce("save");
    vi.mocked(ipc.save).mockResolvedValue(savedDoc(1, "saved"));
    expect(await a.confirmUnsaved()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("closing tabs", () => {
  it("keeps an unsaved tab open when the reader cancels", async () => {
    const a = controller(edited(1, "unsaved"), doc(2, "two"));
    a.activate = async (t: unknown) => {
      a.active = t;
    };
    vi.mocked(ask).mockResolvedValueOnce("cancel");
    expect(await a.closeTab(a.tabs[0])).toBe(false);
    expect(a.tabs).toHaveLength(2);
    expect(ipc.closeDocument).not.toHaveBeenCalled();
  });

  it("shows the right neighbour after closing the active tab", async () => {
    const a = controller(doc(1, "one"), doc(2, "two"), doc(3, "three"));
    a.active = a.tabs[1];
    const shown: unknown[] = [];
    a.activate = async (t: unknown) => {
      shown.push(t);
      a.active = t;
    };
    const third = a.tabs[2];
    expect(await a.closeTab(a.tabs[1])).toBe(true);
    expect(shown).toEqual([third]);
    expect(ipc.closeDocument).toHaveBeenCalledWith(2);
    expect(a.closed.pop()).toBe("doc-2.md");
  });
});
