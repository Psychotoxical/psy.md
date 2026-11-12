//! Core of psy.md: file decoding, safe saving, watching and Markdown rendering.
//! Nothing in here depends on the UI shell, so it can be tested on its own.

pub mod doc_io;
pub mod render;
pub mod sanitize;
pub mod save;
pub mod scope;
pub mod watcher;
