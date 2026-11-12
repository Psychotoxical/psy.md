//! Commands the frontend may call. Heavy work runs on blocking threads; the
//! UI thread never touches the file system.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Instant;

use psymd_core::doc_io::{Eol, Token, encode, token_of};
use psymd_core::render::{Block, Heading, render};
use psymd_core::sanitize::display_path;
use psymd_core::watcher::{DocWatcher, WatchEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::docfs;
use crate::error::CmdError;
use crate::perf;
use crate::state::{AppState, DocSession};
use crate::store;

type CmdResult<T> = Result<T, CmdError>;

fn eol_name(eol: Eol) -> &'static str {
    match eol {
        Eol::Lf => "lf",
        Eol::Crlf => "crlf",
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| CmdError::with_detail("unknown", e.to_string()))
}

fn config_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| CmdError::with_detail("io", e.to_string()))
}

// ---------------------------------------------------------------- startup

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupState {
    settings: Option<Value>,
    session: Option<Value>,
    startup_file: Option<String>,
    platform: &'static str,
}

#[tauri::command]
pub async fn load_state(app: AppHandle, state: State<'_, AppState>) -> CmdResult<StartupState> {
    let dir = config_dir(&app)?;
    let (settings, session) = blocking(move || {
        (
            store::read(&dir, "settings.json"),
            store::read(&dir, "session.json"),
        )
    })
    .await?;
    let startup_file = state
        .startup_file
        .lock()
        .ok()
        .and_then(|mut f| f.take())
        .map(|p| display_path(&p));
    Ok(StartupState {
        settings,
        session,
        startup_file,
        platform: if cfg!(target_os = "macos") {
            "macos"
        } else if cfg!(windows) {
            "windows"
        } else {
            "linux"
        },
    })
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, value: Value) -> CmdResult<()> {
    let dir = config_dir(&app)?;
    blocking(move || store::write(&dir, "settings.json", &value))
        .await?
        .map_err(|e| CmdError::with_detail("io", e))
}

#[tauri::command]
pub async fn save_session(app: AppHandle, value: Value) -> CmdResult<()> {
    let dir = config_dir(&app)?;
    blocking(move || store::write(&dir, "session.json", &value))
        .await?
        .map_err(|e| CmdError::with_detail("io", e))
}

// --------------------------------------------------------------- documents

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDoc {
    session_id: u64,
    path: String,
    name: String,
    dir: String,
    text: String,
    token: String,
    bom: bool,
    eol: &'static str,
    mixed_eol: bool,
    /// Why live updates are unavailable, if they are.
    watch_error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DocEvent {
    session_id: u64,
    seq: u64,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bom: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    eol: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mixed_eol: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<CmdError>,
}

fn emit_doc_event(app: &AppHandle, session_id: u64, event: WatchEvent) {
    let seq = event.seq();
    let payload = match event {
        WatchEvent::Changed { decoded, .. } => DocEvent {
            session_id,
            seq,
            kind: "changed",
            text: Some(decoded.text),
            token: Some(decoded.token.as_str().to_owned()),
            bom: Some(decoded.bom),
            eol: Some(eol_name(decoded.eol)),
            mixed_eol: Some(decoded.mixed_eol),
            problem: None,
        },
        WatchEvent::Missing { .. } => DocEvent {
            session_id,
            seq,
            kind: "missing",
            text: None,
            token: None,
            bom: None,
            eol: None,
            mixed_eol: None,
            problem: None,
        },
        WatchEvent::ReadError { problem, .. } => DocEvent {
            session_id,
            seq,
            kind: "error",
            text: None,
            token: None,
            bom: None,
            eol: None,
            mixed_eol: None,
            problem: Some(problem.into()),
        },
    };
    perf::mark("doc-event", payload.kind);
    let _ = app.emit_to("main", "doc-event", payload);
}

/// Starts a session for `path`; returns its id and a watcher error, if any.
fn start_session(
    app: &AppHandle,
    state: &AppState,
    path: PathBuf,
    known: Token,
) -> CmdResult<(u64, PathBuf, Option<String>)> {
    let parent = path.parent().unwrap_or(Path::new("."));
    let dir = std::fs::canonicalize(parent)?;
    let id = state.next_session.fetch_add(1, Ordering::Relaxed) + 1;
    let handle = app.clone();
    let (watcher, watch_error) = match DocWatcher::start(path.clone(), Some(known), move |e| {
        emit_doc_event(&handle, id, e)
    }) {
        Ok(w) => (Some(w), None),
        Err(e) => (None, Some(e.to_string())),
    };
    state.replace_doc(Some(DocSession {
        id,
        path,
        dir: dir.clone(),
        roots: vec![dir.clone()],
        allow_external_images: false,
        watcher,
    }));
    Ok((id, dir, watch_error))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn open_document(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CmdResult<OpenedDoc> {
    // One spelling per file (separators, `..`) without resolving symlinks.
    let path = std::path::absolute(PathBuf::from(path))?;
    let p = path.clone();
    let decoded = blocking(move || docfs::read_document(&p)).await??;
    let (session_id, dir, watch_error) =
        start_session(&app, &state, path.clone(), decoded.token.clone())?;
    perf::mark("opened", &decoded.text.len().to_string());
    Ok(OpenedDoc {
        session_id,
        name: file_name(&path),
        path: display_path(&path),
        dir: display_path(&dir),
        token: decoded.token.as_str().to_owned(),
        bom: decoded.bom,
        eol: eol_name(decoded.eol),
        mixed_eol: decoded.mixed_eol,
        text: decoded.text,
        watch_error,
    })
}

#[tauri::command]
pub fn close_document(state: State<'_, AppState>) {
    state.replace_doc(None);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderReply {
    req_id: u64,
    ms: f64,
    blocks: Vec<Block>,
    headings: Vec<Heading>,
    has_mermaid: bool,
}

#[tauri::command]
pub async fn render_markdown(
    state: State<'_, AppState>,
    text: String,
    req_id: u64,
) -> CmdResult<RenderReply> {
    let ctx = state.render_ctx();
    blocking(move || {
        let start = Instant::now();
        let r = render(&text, &ctx);
        RenderReply {
            req_id,
            ms: start.elapsed().as_secs_f64() * 1000.0,
            blocks: r.blocks,
            headings: r.headings,
            has_mermaid: r.has_mermaid,
        }
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    text: String,
    bom: bool,
    eol: String,
    /// Token of the disk content the text is based on.
    expected_token: Option<String>,
    /// Replace even if the disk content differs (after the user confirmed).
    force: bool,
    /// Save as: the path chosen in the save dialog.
    target_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDoc {
    session_id: u64,
    token: String,
    path: String,
    name: String,
    dir: String,
}

#[tauri::command]
pub async fn save_document(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SaveRequest,
) -> CmdResult<SavedDoc> {
    let eol = if request.eol == "crlf" {
        Eol::Crlf
    } else {
        Eol::Lf
    };
    let bytes = encode(&request.text, request.bom, eol);
    let token = token_of(&bytes);

    let save_as = request.target_path.is_some();
    let (path, session_id, dir) = match &request.target_path {
        Some(p) => (std::path::absolute(PathBuf::from(p))?, 0, PathBuf::new()),
        None => {
            let guard = state.doc.lock().map_err(|_| CmdError::new("unknown"))?;
            let s = guard.as_ref().ok_or_else(|| CmdError::new("no-document"))?;
            // Tell the watcher first so our own write is never reported back.
            if let Some(w) = &s.watcher {
                w.set_known(token.clone());
            }
            (s.path.clone(), s.id, s.dir.clone())
        }
    };
    let expected = if save_as {
        None
    } else {
        request.expected_token.map(Token::from_string)
    };
    let force = save_as || request.force;
    let p = path.clone();
    let saved =
        blocking(move || psymd_core::save::save(&p, &bytes, expected.as_ref(), force)).await??;
    perf::mark("saved", "");

    let (session_id, dir) = if save_as {
        let (id, dir, _) = start_session(&app, &state, path.clone(), saved.clone())?;
        (id, dir)
    } else {
        (session_id, dir)
    };
    Ok(SavedDoc {
        session_id,
        token: saved.as_str().to_owned(),
        name: file_name(&path),
        path: display_path(&path),
        dir: display_path(&dir),
    })
}

// ------------------------------------------------------------------ dialogs

const MD_FILTER: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "txt"];

#[tauri::command]
pub async fn pick_open_file(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let start_dir = state
        .doc
        .lock()
        .ok()
        .and_then(|d| d.as_ref().map(|s| s.dir.clone()));
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Markdown", MD_FILTER)
        .set_parent(&window);
    if let Some(d) = start_dir {
        dialog = dialog.set_directory(d);
    }
    let picked = blocking(move || dialog.blocking_pick_file()).await?;
    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| display_path(&p)))
}

#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    suggested_name: String,
) -> CmdResult<Option<String>> {
    let start_dir = state
        .doc
        .lock()
        .ok()
        .and_then(|d| d.as_ref().map(|s| s.dir.clone()));
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Markdown", MD_FILTER)
        .set_file_name(suggested_name)
        .set_parent(&window);
    if let Some(d) = start_dir {
        dialog = dialog.set_directory(d);
    }
    let picked = blocking(move || dialog.blocking_save_file()).await?;
    Ok(picked
        .and_then(|f| f.into_path().ok())
        .map(|p| display_path(&p)))
}

// -------------------------------------------------------- links and images

#[tauri::command]
pub async fn resolve_link(state: State<'_, AppState>, href: String) -> CmdResult<String> {
    let dir = state
        .doc
        .lock()
        .ok()
        .and_then(|d| d.as_ref().map(|s| s.dir.clone()))
        .ok_or_else(|| CmdError::new("no-document"))?;
    let path = blocking(move || docfs::resolve_markdown_link(&dir, &href)).await??;
    Ok(display_path(&path))
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> CmdResult<()> {
    if !docfs::external_url_allowed(&url) {
        return Err(CmdError::new("blocked-url"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| CmdError::with_detail("io", e.to_string()))
}

#[tauri::command]
pub fn set_external_images(state: State<'_, AppState>, allowed: bool) {
    if let Ok(mut d) = state.doc.lock()
        && let Some(s) = d.as_mut()
    {
        s.allow_external_images = allowed;
    }
}

#[tauri::command]
pub async fn grant_folder(state: State<'_, AppState>, dir: String) -> CmdResult<()> {
    let real = blocking(move || std::fs::canonicalize(&dir)).await??;
    if !real.is_dir() {
        return Err(CmdError::new("not-found"));
    }
    if let Ok(mut d) = state.doc.lock()
        && let Some(s) = d.as_mut()
        && !s.roots.contains(&real)
    {
        s.roots.push(real);
    }
    Ok(())
}

// ------------------------------------------------------------------- window

#[tauri::command]
pub fn frontend_ready(window: WebviewWindow, state: State<'_, AppState>) {
    state.frontend_ready.store(true, Ordering::Relaxed);
    let _ = window.show();
    let _ = window.set_focus();
    perf::mark("window-shown", "");
}

/// The frontend received a close request and is handling it.
#[tauri::command]
pub fn close_ack(state: State<'_, AppState>) {
    state.pending_close.store(0, Ordering::Relaxed);
}

#[tauri::command]
pub fn confirm_close(app: AppHandle, window: WebviewWindow) {
    let _ = app.save_window_state(StateFlags::all() & !StateFlags::VISIBLE);
    let _ = window.destroy();
}

#[tauri::command]
pub fn set_window_theme(window: WebviewWindow, theme: Option<String>) {
    let t = match theme.as_deref() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    };
    let _ = window.set_theme(t);
}

#[tauri::command]
pub fn set_title(window: WebviewWindow, title: String) {
    let title: String = title.chars().take(300).collect();
    let _ = window.set_title(&title);
}

#[tauri::command]
pub fn set_language(app: AppHandle, lang: String) {
    crate::menu::install(&app, &lang);
}

#[tauri::command]
pub fn perf_mark(name: String, detail: Option<String>) {
    perf::mark(&name, detail.as_deref().unwrap_or(""));
}
