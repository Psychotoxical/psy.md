// Saving and switching documents while a write is still running.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { type DocState, isDirty, openDoc, reduce } from "./doc/model";
import { ipc, type SavedDoc } from "./ipc";
import { ask } from "./ui/dialog";

vi.mock("./ipc", () => ({
  ipc: { save: vi.fn(), openDocument: vi.fn(), pickSavePath: vi.fn() },
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

function savedDoc(id: number, token: string, path = `doc-${id}.md`): SavedDoc {
  return { sessionId: id, token, path, name: path, dir: "." };
}

// The controller without its window: only what saving and switching touch.
// biome-ignore lint/suspicious/noExplicitAny: test access to private members
function controller(start: DocState): any {
  const a = Object.create(App.prototype);
  Object.assign(a, {
    doc: start,
    saving: false,
    saveJob: null,
    session: { lastFile: null, recent: [] },
    refreshChrome: () => {},
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
  vi.mocked(ipc.save).mockReset();
  vi.mocked(ipc.openDocument).mockReset();
  vi.mocked(ipc.pickSavePath).mockReset();
  vi.mocked(ask).mockReset();
});

describe("saving while documents change", () => {
  it("sends the session of the document being saved", async () => {
    const a = controller(edited(1, "first"));
    vi.mocked(ipc.save).mockResolvedValue(savedDoc(1, "saved"));
    await a.writeDoc(false);
    expect(vi.mocked(ipc.save).mock.calls[0]?.[0].sessionId).toBe(1);
  });

  it("ignores a save answer for a document that is no longer open", async () => {
    const a = controller(edited(1, "first"));
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    const saving = a.writeDoc(false);
    a.doc = doc(2, "second file");
    save.resolve(savedDoc(1, "saved-1"));
    await saving;
    expect(a.doc.file.sessionId).toBe(2);
    expect(a.doc.base.text).toBe("second file");
    expect(a.doc.base.token).toBe("t2");
    expect(isDirty(a.doc)).toBe(false);
  });

  it("does not move another document to the target of an earlier save as", async () => {
    const a = controller(doc(1, "clean"));
    vi.mocked(ipc.pickSavePath).mockResolvedValue("copy.md");
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    const saving = a.saveAs();
    await tick();
    a.doc = doc(2, "second file");
    save.resolve(savedDoc(3, "saved-copy", "copy.md"));
    await saving;
    expect(a.doc.file.sessionId).toBe(2);
    expect(a.doc.file.path).toBe("doc-2.md");
  });

  it("opens another file only after a running save has finished", async () => {
    const a = controller(edited(1, "first"));
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    vi.mocked(ipc.openDocument).mockReturnValue(new Promise(() => {}));
    void a.save();
    await tick();
    void a.openPath("doc-2.md");
    await tick();
    expect(ipc.openDocument).not.toHaveBeenCalled();
    save.resolve(savedDoc(1, "saved"));
    await tick();
    await tick();
    // The save made the document clean, so no question was needed.
    expect(ask).not.toHaveBeenCalled();
    expect(ipc.openDocument).toHaveBeenCalledWith("doc-2.md");
  });

  it("asks again before closing when typing went on during the save", async () => {
    const a = controller(edited(1, "first"));
    vi.mocked(ask).mockResolvedValueOnce("save").mockResolvedValueOnce("cancel");
    const save = pending<SavedDoc>();
    vi.mocked(ipc.save).mockReturnValue(save.promise);
    const released = a.confirmUnsaved();
    await tick();
    a.doc = reduce(a.doc, { type: "edited", text: "typed while saving" });
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
