# Third-party software and assets

psy.md is MIT-licensed. It bundles or links the following.

## Bundled assets

| Asset | License | Source |
|---|---|---|
| Inter (variable, Latin and Latin Extended subsets) | SIL Open Font License 1.1 | `@fontsource-variable/inter` |
| Catppuccin Mocha and Latte colour values | MIT | catppuccin/palette (values copied into `src/styles/tokens.css`) |
| App icon | MIT (part of this project) | drawn by `scripts/make-icon.mjs` |

## Frontend runtime (bundled into the app)

| Package | License |
|---|---|
| @codemirror/state, view, commands, language, lang-markdown, search, language-data (and the grammars they load) | MIT |
| @lezer/highlight and Lezer grammars | MIT |
| mermaid (and its bundled dependencies, loaded only for diagrams) | MIT |
| @tauri-apps/api | Apache-2.0 OR MIT |

## Rust (direct dependencies)

| Crate | License |
|---|---|
| tauri, tauri-build, tauri-plugin-dialog, tauri-plugin-opener, tauri-plugin-window-state | Apache-2.0 OR MIT |
| comrak | BSD-2-Clause |
| ammonia | MIT OR Apache-2.0 |
| notify | CC0-1.0 |
| serde, serde_json, url, percent-encoding, thiserror | MIT OR Apache-2.0 |

The full resolved Rust graph (all platforms) has about 480 crates. Almost all
are MIT and/or Apache-2.0; others are Zlib, ISC, BSD-2/3-Clause, Unicode-3.0,
Unlicense, CC0-1.0 and 0BSD (each offered alongside MIT or Apache-2.0 where
noted by the crate). A few crates pulled in by HTML parsing and by Tauri
(`cssparser`, `selectors`, `dtoa-short`, `option-ext`) are MPL-2.0, which
applies per file and is used unmodified. To list everything:

```bash
cargo metadata --format-version 1
```

## Development tools (not shipped)

Vite, TypeScript, Vitest, happy-dom, Biome, @tauri-apps/cli, tempfile — all
MIT or Apache-2.0.

## Platform components (not part of psy.md)

The app uses the operating system's webview: Microsoft Edge WebView2 on
Windows, WKWebView on macOS, WebKitGTK on Linux.
