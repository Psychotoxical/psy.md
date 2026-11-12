//! Shared app state.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64};

use psymd_core::render::RenderCtx;
use psymd_core::watcher::DocWatcher;

/// The open document. A new session (new id) starts on every open and every
/// "save as", so events from an earlier file can be told apart.
pub struct DocSession {
    pub id: u64,
    pub path: PathBuf,
    /// Canonical folder of the document.
    pub dir: PathBuf,
    /// Canonical folders local images may come from.
    pub roots: Vec<PathBuf>,
    pub allow_external_images: bool,
    pub watcher: Option<DocWatcher>,
}

impl DocSession {
    pub fn render_ctx(&self) -> RenderCtx {
        RenderCtx {
            doc_dir: Some(self.dir.clone()),
            roots: self.roots.clone(),
            allow_external_images: self.allow_external_images,
        }
    }
}

#[derive(Default)]
pub struct AppState {
    pub doc: Mutex<Option<DocSession>>,
    pub next_session: AtomicU64,
    /// File passed on the command line or by the OS before the UI was ready.
    pub startup_file: Mutex<Option<PathBuf>>,
    pub frontend_ready: AtomicBool,
    /// Epoch ms of a close request the frontend has not acknowledged yet.
    pub pending_close: AtomicU64,
}

impl AppState {
    pub fn render_ctx(&self) -> RenderCtx {
        self.doc
            .lock()
            .ok()
            .and_then(|d| d.as_ref().map(DocSession::render_ctx))
            .unwrap_or_default()
    }

    pub fn roots(&self) -> Vec<PathBuf> {
        self.doc
            .lock()
            .ok()
            .and_then(|d| d.as_ref().map(|s| s.roots.clone()))
            .unwrap_or_default()
    }

    /// Replaces the open document; the previous watcher stops outside the lock.
    pub fn replace_doc(&self, session: Option<DocSession>) {
        let old = match self.doc.lock() {
            Ok(mut d) => std::mem::replace(&mut *d, session),
            Err(_) => None,
        };
        drop(old);
    }
}
