# Performance

Measured on the release build on Windows and macOS. Linux numbers are not
available yet. The two machines differ a lot (a current desktop and a 2017
dual-core laptop), so the platforms are not compared like for like.

## Setup

| | Windows | macOS |
|---|---|---|
| CPU | Intel Core i5-12400F (6 cores, 12 threads) | Intel Core i5-7360U (2 cores, 4 threads) |
| RAM | 32 GB | 8 GB |
| Disk | NVMe SSD (project and samples), WebView2 data on the system SSD | Internal SSD |
| OS | Windows 11 Pro, build 26200 | macOS 15.8.3 |
| Webview | Microsoft Edge WebView2 Runtime 157 | WKWebView (system WebKit) |
| Build | `npx tauri build` (release profile: LTO, one codegen unit, stripped) | same |
| Other | A third-party virus scanner with real-time file scanning was active; it can add delay to file reads and process start. | Display kept awake with `caffeinate -d` |

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
- **Memory:** on Windows, working set and private bytes of `psymd.exe`, and
  separately of the WebView2 processes it started (browser, renderer, GPU,
  utility). The WebView2 runtime is part of Windows; its share is listed apart
  from the app. On macOS, RSS and physical footprint (`footprint`, the closest
  match to private bytes) of the app and of the WebKit processes that appeared
  after it started; they run as XPC services, not as children of the app.
- **Size:** the executable and the installer.

The display has to stay awake and unlocked during a run. Large documents are
inserted over several animation frames; with the display off there are no
frames, and `doc-1m.md` and `doc-10m.md` never finished in such a run on
macOS.

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

On macOS:

```bash
caffeinate -d node scripts/measure.mjs target/release/psymd perf-samples 5
```

## Results: Windows

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

## Results: macOS

One run of `measure.mjs` with 5 start-ups, 3 opens per document and 15
external updates, on 2026-11-12. Medians, with the range of the individual
runs in brackets.

### Start-up and open

| Measurement | Median | Runs |
|---|---|---|
| Start-up without a document, window shown | 1004 ms | 991–1795 |
| File read (`opened`), any sample | 997–1036 ms | 992–1194 |
| Open `doc-100k.md` (103 KB), document on screen | 1152 ms | 1141–1217 |
| Open `doc-1m.md` (1.0 MB) | 2321 ms | 2314–2323 |
| Open `doc-10m.md` (10.5 MB) | 11 976 ms | 11 875–12 771 |
| Open `tables.md` (61 KB) | 1122 ms | 1108–1205 |
| Open `code.md` (107 KB) | 1050 ms | 1044–1068 |
| Open `mermaid.md` (diagrams render afterwards, not included) | 1074 ms | 1026–1287 |

As on Windows, most of the first second passes before the file is read. For
`doc-10m.md` the window appears after about 1570 ms.

### External update

| Measurement | Median | Range |
|---|---|---|
| Atomic replace of the open 100 KB file → change applied on screen | 133 ms | 130–147 |
| Atomic replace → watcher event reaches the app | 91 ms | 88–93 |

Both include the watcher's 75 ms debounce. On the slower machine the update
latency matches Windows.

### Memory

RSS / physical footprint, sampled as on Windows. WebKit is the sum of the 2
WebKit processes that appeared with the app.

| State | psy.md process | WebKit processes |
|---|---|---|
| Idle, no document | 78.9 / 22.0 MB | 81.4 / 23.4 MB |
| `doc-100k.md` | 81.3 / 23.0 MB | 133.3 / 77.4 MB |
| `doc-1m.md` | 93.4 / 26.0 MB | 268.8 / 194.4 MB |
| `doc-10m.md` | 81.2 / 33.0 MB | 1472.9 / 1443.4 MB |

RSS includes shared system frameworks; the footprint is the app's own share.

### Size

| Item | Size |
|---|---|
| `psymd` (frontend embedded) | 8 494 920 bytes (8.1 MB) |
| `psy.md.app` | 8.2 MB |
| DMG | not measured (the DMG step failed on the test machine) |

## Not measured

- Linux (WebKitGTK).
- Typing latency in the editor of a large file.
- Memory over a long session with many external updates.
