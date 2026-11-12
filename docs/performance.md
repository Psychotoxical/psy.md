# Performance

Measured on the release build. Only Windows was measured; macOS and Linux
numbers are not available yet.

## Setup

| | |
|---|---|
| CPU | Intel Core i5-12400F (6 cores, 12 threads) |
| RAM | 32 GB |
| Disk | NVMe SSD (project and samples), WebView2 data on the system SSD |
| OS | Windows 11 Pro, build 26200 |
| Webview | Microsoft Edge WebView2 Runtime 157 |
| Build | `npx tauri build` (release profile: LTO, one codegen unit, stripped) |
| Other | A third-party virus scanner with real-time file scanning was active; it can add delay to file reads and process start. |

## Method

`scripts/measure.mjs` starts the release executable with `PSYMD_PERF=<log>`.
The app then appends timing marks to that log: process start
(`t=0`), file read (`opened`), document on screen (`doc-shown`), window shown
(`window-shown`), interface ready (`ui-ready`), watcher event (`doc-event`)
and update applied (`external-applied`). Each mark carries the wall-clock time
in epoch milliseconds, so the script compares it with its own clock:

- **Start-up:** script spawns the process → `window-shown` (window visible
  with the empty state or document rendered) and → `ui-ready`.
- **Open:** spawn with a file argument → `doc-shown` (rendered blocks in the
  DOM; diagrams and code highlighting finish asynchronously afterwards).
- **External update latency:** the script writes a temporary file and renames
  it over the open 100 KB document, then waits for `external-applied`
  (watcher debounce of 75 ms included). 15 updates, 600 ms apart.
- **Memory:** working set and private bytes of `psymd.exe`, and separately of
  the WebView2 processes it started (browser, renderer, GPU, utility). The
  WebView2 runtime is part of Windows; its share is listed apart from the app.
- **Size:** the executable and the NSIS installer.

Synthetic documents come from `scripts/gen-samples.mjs` (generated text only):
`doc-100k.md`, `doc-1m.md`, `doc-10m.md` (headings, paragraphs, lists, tables,
code blocks), `tables.md`, `code.md`, `mermaid.md`.

Reproduce:

```bash
node scripts/gen-samples.mjs perf-samples
```

```bash
node scripts/measure.mjs target/release/psymd.exe perf-samples 5
```

## Results

One run of `measure.mjs` with 5 start-ups, 3 opens per document and 15
external updates, on 2026-11-12. Times are milliseconds after the process was
spawned; medians, with the range of the individual runs in brackets.

### Start-up and open

| Measurement | Median | Runs |
|---|---|---|
| Start-up without a document, window shown | 454 ms | 426–563 |
| File read (`opened`), any sample | 424–438 ms | 415–446 |
| Open `doc-100k.md` (103 KB), document on screen | 515 ms | 502–528 |
| Open `doc-1m.md` (1.0 MB) | 998 ms | 994–1017 |
| Open `doc-10m.md` (10.5 MB, 48 470 blocks) | 5957 ms | 5913–5959 |
| Open `tables.md` (61 KB) | 481 ms | 473–491 |
| Open `code.md` (107 KB) | 462 ms | 461–474 |
| Open `mermaid.md` (diagrams render afterwards, not included) | 440 ms | 439–441 |

Most of the first ~420 ms is process and WebView2 start; the file is read
right after. For `doc-10m.md` the window appears after about 930 ms while the
rest of the document is still being inserted; the 5.96 s is until the last
block is in the DOM. How that time splits between rendering in Rust and
building the DOM was not measured on the release build.

### External update

| Measurement | Median | Range |
|---|---|---|
| Atomic replace of the open 100 KB file → change applied on screen | 137 ms | 128–146 |
| Atomic replace → watcher event reaches the app | 103 ms | 99–116 |

Both include the watcher's 75 ms debounce.

### Memory

Working set / private bytes, sampled 2 s after the document was on screen
(idle: 1.5 s after the interface was ready).
WebView2 is the sum of the 6 runtime processes the app started (browser,
renderer, GPU, utility processes); it is part of Windows and shared code
counts towards each process's working set.

| State | psy.md process | WebView2 processes |
|---|---|---|
| Idle, no document | 28.5 / 5.4 MB | 322.8 / 156.3 MB |
| `doc-100k.md` | 29.6 / 5.7 MB | 377.4 / 199.4 MB |
| `doc-1m.md` | 29.7 / 5.6 MB | 591.2 / 414.6 MB |
| `doc-10m.md` | 31.2 / 7.4 MB | 2243.6 / 2089.4 MB |

The app process stays near 30 MB; document memory lives in the webview,
which keeps the whole rendered document in the DOM (about 300 000 elements
for the 10 MB sample).

### Size

| Item | Size |
|---|---|
| `psymd.exe` (frontend embedded) | 8 448 000 bytes (8.1 MB) |
| NSIS installer | 4 014 467 bytes (3.83 MiB) |
| Frontend loaded at start (`index.js` + `index.css`) | 77 kB + 26 kB (25 kB + 7 kB gzip) |
| Whole frontend bundle | 7.0 MB; the editor loads on first switch to Source or Split, the code grammars when a code block nears the viewport, Mermaid (most of the 7 MB) only for documents with diagrams |

### Findings from the measurements

- An earlier build gave large documents `content-visibility: auto` on every
  top-level block. In WebView2 this made the first style pass grow with the
  square of the block count: 79 s of style recalculation for `doc-10m.md`
  (traced with the DevTools timeline), 59 s until the document was shown.
  The rule was removed.
- Inserting in fixed chunks of 800 blocks meant 64 frames for `doc-10m.md`,
  each laying out the whole document so far (12 s of layout in the dev
  build). Chunks now double in size every frame (7 frames); layout dropped
  to 2.3 s in the dev build.
- Between the first and the final measurement, `data-sourcepos` was limited
  to block elements and code highlighting became lazy (on approach to the
  viewport). WebView2 memory with `doc-1m.md` went from 898 MB to 591 MB;
  each change was not measured on its own.

### Not measured

- macOS and Linux (WKWebView, WebKitGTK).
- Typing latency in the editor of a large file.
- Memory over a long session with many external updates.
