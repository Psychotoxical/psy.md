//! Shared app state.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use psymd_core::render::RenderCtx;
use psymd_core::watcher::DocWatcher;

/// One open document (one tab). A new session (new id) starts on every open
/// and every "save as", so events from an earlier file can be told apart.
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
    /// All open documents by session id.
    pub docs: Mutex<HashMap<u64, DocSession>>,
    /// The session shown in the window (0: none). Its folders serve images.
    pub active: AtomicU64,
    pub next_session: AtomicU64,
    /// Files passed on the command line or by the OS before the UI was ready.
    pub startup_files: Mutex<Vec<PathBuf>>,
    pub frontend_ready: AtomicBool,
    /// Epoch ms of a close request the frontend has not acknowledged yet.
    pub pending_close: AtomicU64,
}

impl AppState {
    pub fn render_ctx(&self, id: u64) -> RenderCtx {
        self.with_doc(id, |s| s.render_ctx()).unwrap_or_default()
    }

    /// Image folders of the document on screen.
    pub fn roots(&self) -> Vec<PathBuf> {
        let id = self.active.load(Ordering::Relaxed);
        self.with_doc(id, |s| s.roots.clone()).unwrap_or_default()
    }

    /// Runs `f` on an open session; `None` if it is not open (any more).
    pub fn with_doc<T>(&self, id: u64, f: impl FnOnce(&mut DocSession) -> T) -> Option<T> {
        let mut docs = self.docs.lock().ok()?;
        docs.get_mut(&id).map(f)
    }

    pub fn insert_doc(&self, session: DocSession) {
        if let Ok(mut docs) = self.docs.lock() {
            docs.insert(session.id, session);
        }
    }

    /// Closes a session; its watcher stops outside the lock.
    pub fn remove_doc(&self, id: u64) {
        let old = self.docs.lock().ok().and_then(|mut d| d.remove(&id));
        let _ = self
            .active
            .compare_exchange(id, 0, Ordering::Relaxed, Ordering::Relaxed);
        drop(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: u64, dir: &str) -> DocSession {
        DocSession {
            id,
            path: PathBuf::from(dir).join("doc.md"),
            dir: PathBuf::from(dir),
            roots: vec![PathBuf::from(dir)],
            allow_external_images: false,
            watcher: None,
        }
    }

    #[test]
    fn several_documents_stay_open_side_by_side() {
        let s = AppState::default();
        s.insert_doc(session(1, "a"));
        s.insert_doc(session(2, "b"));
        assert_eq!(s.with_doc(1, |d| d.dir.clone()), Some(PathBuf::from("a")));
        assert_eq!(s.with_doc(2, |d| d.dir.clone()), Some(PathBuf::from("b")));
        assert_eq!(s.with_doc(3, |d| d.id), None);
    }

    #[test]
    fn images_come_from_the_folders_of_the_active_document() {
        let s = AppState::default();
        s.insert_doc(session(1, "a"));
        s.insert_doc(session(2, "b"));
        assert!(s.roots().is_empty());
        s.active.store(2, Ordering::Relaxed);
        assert_eq!(s.roots(), [PathBuf::from("b")]);
    }

    #[test]
    fn closing_the_active_document_leaves_no_image_folders() {
        let s = AppState::default();
        s.insert_doc(session(1, "a"));
        s.insert_doc(session(2, "b"));
        s.active.store(1, Ordering::Relaxed);
        s.remove_doc(2);
        assert_eq!(s.roots(), [PathBuf::from("a")]);
        s.remove_doc(1);
        assert!(s.roots().is_empty());
        assert_eq!(s.active.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn render_context_belongs_to_the_asked_document() {
        let s = AppState::default();
        s.insert_doc(session(1, "a"));
        assert_eq!(s.render_ctx(1).doc_dir, Some(PathBuf::from("a")));
        assert_eq!(s.render_ctx(9).doc_dir, None);
    }
}
