# psy.md

A quiet Markdown viewer with an integrated editor for Windows, macOS and Linux.

psy.md is built for one situation: another program — an editor, a script, an
automation — writes a Markdown file, and you watch the result. The preview stays
current while the file changes, keeps your reading position, and marks what
changed. When you want to change something yourself, the source editor is one
keystroke away, and psy.md never overwrites anyone's changes without asking.

## Features

- **Live updates** that survive atomic saves (write temp file, rename),
  rapid writes, files that briefly disappear or go empty, and deletion.
- **Change bars** in the margin and a footer line that says what changed and
  where.
- **Preview, source editor and split view** with synchronized scrolling,
  undo/redo, line numbers and wrapping.
- **Safe saving**: atomic replace, UTF-8 with or without BOM, original line
  endings kept, conflicts detected before anything is written.
- **Conflict handling** when the file changes while you have unsaved edits:
  keep yours, save yours elsewhere, or explicitly discard and reload.
- **GitHub Flavored Markdown**: tables, task lists, strikethrough, autolinks,
  footnotes, syntax-highlighted code blocks with copy buttons, Mermaid
  diagrams (a broken diagram shows its error and source).
- **Links and images**: relative Markdown links and heading anchors open in
  psy.md, web links in your browser; local images from the document folder;
  external images only after you allow them.
- **Contents** with outline numbers and the current section marked; find in
  the preview and in the editor (case-insensitive, umlaut-aware).
- **Catppuccin Mocha and Latte**, or follow the system; system font or the
  bundled Inter; content zoom from 50 % to 250 %.
- **English and German**, switchable without restart.
- Offline. No accounts, no telemetry, nothing loaded from the network unless
  you allow external images in a document.

## Keyboard

On macOS use ⌘ instead of Ctrl.

| Action | Shortcut |
|---|---|
| Open | Ctrl+O |
| Save / Save as | Ctrl+S / Ctrl+Shift+S |
| Find, next, previous | Ctrl+F, Enter, Shift+Enter |
| Close find, menus, overlays | Esc |
| Preview / Split / Source | Ctrl+1 / Ctrl+2 / Ctrl+3 |
| Contents on/off | Ctrl+Shift+T |
| Zoom in / out / reset | Ctrl++ / Ctrl+− / Ctrl+0, or Ctrl+mouse wheel |
| Settings | Ctrl+, |

Open a file by passing its path (`psymd notes.md`), with the file dialog, by
dragging it into the window, or from the recent files in the file menu.

## Build and run

Requirements: Rust (stable, 1.88+), Node.js 22.12+ or 24, and the Tauri
system prerequisites for your platform
(<https://v2.tauri.app/start/prerequisites/>). On Linux that includes
WebKitGTK 4.1.

```bash
npm ci
```

```bash
npm run tauri dev
```

```bash
npm run tauri build
```

Installers end up in `target/release/bundle/` (NSIS on Windows, DMG and app
on macOS, DEB and AppImage on Linux).

## Checks

```bash
npm run check
```

```bash
npm test
```

```bash
cargo fmt --all -- --check
```

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

```bash
cargo test --workspace
```

`samples/` holds documents for manual checks, and
`node scripts/simulate-writer.mjs <file> <mode> …` imitates another program
writing a file (atomic replace, in-place writes, bursts, truncate-then-write).
`docs/performance.md` describes how the release build was measured.

## Where things live

- `crates/core` — reading, saving, watching, rendering and sanitizing (no UI).
- `src-tauri` — the desktop shell: commands, image protocol, window handling.
- `src` — the interface (TypeScript without a framework, CodeMirror 6).
- `docs/architecture.md` — design decisions, data safety, security model.

## Known limitations

- Only UTF-8 files are opened; UTF-16 and other encodings are reported and
  not converted.
- Files over 32 MB are refused. Very large documents are slow and heavy: a
  10 MB file took about 6 s to appear completely and about 2.2 GB of webview
  memory on the test machine (see `docs/performance.md`). Typing in the editor
  of a multi-megabyte file re-renders the preview less often.
- Raw HTML is reduced to passive elements; anything interactive or styled is
  removed.
- Images do not reload when only the image file changes; they refresh with
  the next change to the document.
- A renamed file is reported as missing; psy.md does not follow the new name.
- Mermaid needs a recent webview (Safari 17.4 / macOS 14.4 or newer on macOS;
  a current WebKitGTK on Linux). Diagrams render with the system font even
  when Inter is selected.
- Hard links are replaced by a new file on save (the atomic rename creates a
  new file at the path).
- No tabs, folder tree, PDF export or WYSIWYG editing in this version.

## License

MIT. Third-party licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
