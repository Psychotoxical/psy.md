# psy.md architecture

psy.md is a Markdown viewer with an integrated source editor. Its main use is
watching a file that another program (an editor, a script, an automation) is
writing, and editing it occasionally without ever losing a change.

Priorities, in order: no lost or silently overwritten changes; correct
rendering and reliable live updates; fast start and smooth use; a calm,
distinct design; a small feature set and maintainable code.

## Overview

```
┌──────────────────────────── webview (TypeScript, no UI framework) ─────────┐
│ app.ts            controller: document lifecycle, views, menus, chrome      │
│ doc/model.ts      pure state machine of the open document (tested)          │
│ preview/*         render requests, keyed block diff, reading anchor,        │
│                   revision marks, link handling, highlighting, Mermaid      │
│ editor/editor.ts  CodeMirror 6 (loaded on first use of Source/Split)        │
│ search/*, toc/*, split/*, ui/*, i18n/*, settings.ts, keys.ts                │
│ ipc.ts            the only module that calls the shell                      │
└───────────────▲─────────────────────────────────────┬──────────────────────┘
                │ events: doc-event, open-file,         │ commands (typed)
                │ drag-state, close-requested, menu     ▼
┌──────────────────────────── shell (src-tauri, Rust) ───────────────────────┐
│ commands.rs   open/save/render/dialogs/links/settings, all off the UI thread│
│ protocol.rs   psymd-asset: serves images inside the allowed folders only    │
│ store.rs      settings.json / session.json in the app config folder        │
│ menu.rs       localized native menu (macOS)                                 │
│ lib.rs        window events: close request, drag and drop, file open        │
└───────────────▲────────────────────────────────────────────────────────────┘
                │ plain Rust API
┌──────────────────────────── crates/core (no Tauri) ────────────────────────┐
│ doc_io.rs    decode/encode: UTF-8 only, BOM and line endings kept, tokens   │
│ save.rs      conflict check + atomic replace through a temporary file       │
│ watcher.rs   directory watch, debounce, empty/missing stabilization         │
│ render.rs    comrak (GFM) → one HTML block per top-level node + headings    │
│ sanitize.rs  ammonia allowlist, link/image URL policy                       │
│ scope.rs     which local images may be served                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

The core crate holds every rule that protects data or the user and is tested
without a window. The shell is thin glue. The frontend owns layout and
interaction; its pure parts (model, diff, anchors, search folding, key
mapping, numbering, settings parsing) have unit tests.

## Decisions

| Area | Choice | Why |
|---|---|---|
| Shell | Tauri 2 | Small binaries, native webview, Rust for file work. Electron was ruled out. |
| Frontend | TypeScript without a UI framework, Vite | The UI has few, stable views; plain DOM keeps the bundle and start-up small and avoids a framework runtime. |
| Markdown | comrak in Rust | Full CommonMark + GFM, source positions on every block, runs off the UI thread. |
| Sanitizing | ammonia in Rust | html5ever-based allowlist sanitizer; output is inert before it reaches the webview. |
| Editor | CodeMirror 6 | Small, accessible, mature; history, search and Markdown grammar without an IDE stack. |
| Code highlighting | Lezer grammars via `@codemirror/language-data` | Same grammars as the editor, each language loads on first use. |
| Diagrams | Mermaid, loaded on demand | Only documents with diagrams load it. |
| Watching | notify on the parent folder | Survives "write temp, rename over target" saves. |

## Data safety

- **Tokens.** Every disk version has a token (length + 64-bit hash of the raw
  bytes). The frontend's document model keeps the token of the version its
  buffer is based on.
- **Saving** sends that token. The shell re-reads the file, and if it differs,
  returns `conflict` and changes nothing. Only an explicit confirmation sends
  `force`. Then the bytes go to a temporary file in the same folder, are
  synced, get the original permissions and are renamed over the target
  (retried briefly on Windows sharing violations). Symlinks are followed so
  the link survives and the real file is replaced.
- **Encoding.** Only UTF-8 (with or without BOM) is read. UTF-16 and invalid
  UTF-8 are reported, never decoded lossily, so a save can never write
  replacement characters. BOM and the dominant line ending are restored on
  save.
- **External changes** never replace local edits: with unsaved edits the new
  disk version waits as "pending" and the conflict bar offers keep, save as,
  or an explicitly confirmed discard. Without edits the file reloads.
- **No autosave** to the source file, no claim that unsaved text is kept
  anywhere. Closing a tab or the window with unsaved edits asks first.

## Live updates

The watcher ([crates/core/src/watcher.rs](../crates/core/src/watcher.rs)):

- watches the parent folder non-recursively and filters by file name;
- runs one check after 75 ms of quiet, and at the latest 400 ms after the
  first event of a burst, so long writes still show progress;
- ignores content identical to the last known token (including psy.md's own
  saves, announced to the watcher before writing);
- re-reads an empty file after 350 ms before reporting it, so
  truncate-then-write never shows an empty page;
- re-checks a vanished file after 100, 300 and 1000 ms before reporting it
  missing, then polls every 2 s until it returns;
- retries transient read errors and reports lasting ones; the last good
  content stays on screen.

Events carry a sequence number and a session id; the frontend drops stale
ones. Render requests carry an id; only the newest reply is applied.

## Tabs

Every open file is a tab and has its own backend session (watcher, image
folders, external-image choice), kept in `AppState.docs` by session id. Only
the active tab is rendered; the backend serves images from the active tab's
folders (`set_active`). A tab in the background keeps its document state up
to date from its watcher and shows a square when the file changed (peach),
has a conflict or went missing (red); an unsaved tab shows a dot.

Switching keeps per tab: the reading line, the editor state with its own undo
history, the change marks by block key, and the block keys on screen. When a
tab comes back, blocks whose keys the reader has not seen get change marks
and the footer summarizes them, as for an update in the active tab.

A save carries its session id and applies to its own tab, even if another tab
is on screen by then; a save for a tab closed in the meantime is refused by
the backend (`stale-session`). Opening, switching and closing wait for a
running save. Closing a tab or the window asks about every tab with unsaved
edits.

A second start of psy.md hands its files to the running one
(`tauri-plugin-single-instance`), which opens each as a tab and comes to the
front; drag and drop and the macOS "open with" event open all files the same
way. `session.json` stores the open tabs with their reading lines and the
active one; a session from before tabs (`lastFile`) becomes one tab.

The preview applies a rendering with a keyed diff
([src/preview/apply.ts](../src/preview/apply.ts)): each block's key is a hash
of its HTML without line numbers, unchanged blocks keep their DOM (rendered
diagrams, loaded images, highlighted code), and only new blocks are built.
Before applying, the block at the top of the viewport is recorded; afterwards
the same block (or the next surviving one, or the same source line) is put
back at the same offset. A reader scrolled to the very end stays at the end.

Blocks created by an external change get a revision bar in the left gutter and
the footer names how many blocks changed and in which section.

## Security model

Documents are untrusted.

- No script runs from documents. Raw HTML passes through an allowlist of
  passive tags; `script`, `style`, frames, objects, forms, media, SVG and
  MathML are removed, as are event handlers, `style` attributes and unknown
  classes. Document ids get an `h-` prefix so they cannot collide with the UI.
- Links: only `http`, `https`, `mailto` and relative targets. Clicks are
  handled by the app: anchors scroll, web links open in the default browser
  after a scheme check in Rust, relative links open only existing Markdown
  files. Nothing else is opened.
- Images: local images inside the document folder load through
  `psymd-asset:`, which canonicalizes the path, rejects anything outside the
  allowed folders (symlinks and `..` included), serves image types only and
  at most 25 MB. Images outside the folder, missing images and external
  images show an explanation; external images load only after an explicit
  per-document choice, folders only after an explicit grant.
- Mermaid runs in strict mode with HTML labels off; the SVG is shown as an
  `<img>` data URL, which cannot run script or fetch anything.
- CSP: `script-src 'self'`, no frames or objects, `connect-src` limited to
  the IPC endpoint. `style-src` allows inline styles (CodeMirror and Mermaid
  need them); Tauri's nonce injection for `style-src` is disabled so that
  directive stays as written.
- IPC: every app command is listed in `build.rs`; the main window's
  capability grants exactly those plus event listening. Dialogs and the
  opener are used from Rust only, so the frontend holds no plugin
  permissions.
- Nothing is logged about document content. The optional performance log
  (`PSYMD_PERF=<file>`) records timings and sizes only.

## Limits

| What | Limit |
|---|---|
| Document size | 32 MB (larger files are refused with a message) |
| Local image | 25 MB |
| Mermaid source per diagram | 30 000 characters |
| Mermaid diagrams per document | 50 |
| Code block highlighting | up to 120 000 characters per block |
| Documents with more than 1 500 blocks | inserted over several frames: 400 blocks first, then each chunk twice the previous (about 7 frames for 50 000 blocks), so the first screen shows early and the total layout work stays proportional to the document |

## Settings and session

`settings.json` (theme, language, font, zoom, change marks) and `session.json`
(open tabs with their reading lines, the active tab, view, contents, split
ratio, recent files) live in
the app config folder and are written atomically. Invalid values fall back to
defaults; an unreadable file is kept as `*.bad`. Window size and position are
restored by the window-state plugin.

## Tests

- `cargo test` — core (decode, save, render, sanitize, scope, 13 real
  file-system watcher scenarios) and shell helpers.
- `npm test` — Vitest with happy-dom for the frontend logic.
- `npm run check` — Biome (format + lint) and TypeScript for app and tests.
