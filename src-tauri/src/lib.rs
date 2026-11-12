//! psy.md desktop shell: file access, watching, rendering and the window.
//! The core logic lives in `psymd-core`; this crate wires it to Tauri.

mod commands;
mod docfs;
mod error;
mod menu;
mod perf;
mod protocol;
mod state;
mod store;

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{DragDropEvent, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use crate::state::AppState;

/// After this long without an answer to a close request, the frontend is
/// considered unresponsive and a second close request closes the window.
const CLOSE_TIMEOUT_MS: u64 = 4000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DragState {
    active: bool,
    markdown: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn startup_file() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .find(|a| !a.to_string_lossy().starts_with('-'))
        .map(PathBuf::from)
}

pub fn run() {
    perf::init();
    let state = AppState::default();
    if let Ok(mut f) = state.startup_file.lock() {
        *f = startup_file();
    }

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .invoke_handler(tauri::generate_handler![
            commands::load_state,
            commands::save_settings,
            commands::save_session,
            commands::open_document,
            commands::close_document,
            commands::render_markdown,
            commands::save_document,
            commands::pick_open_file,
            commands::pick_save_path,
            commands::resolve_link,
            commands::open_external,
            commands::set_external_images,
            commands::grant_folder,
            commands::frontend_ready,
            commands::close_ack,
            commands::confirm_close,
            commands::set_window_theme,
            commands::set_title,
            commands::set_language,
            commands::perf_mark,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            menu::install(&handle, "en");
            menu::forward_events(&handle);
            // Show the window even if the frontend never reports ready.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if !handle
                    .state::<AppState>()
                    .frontend_ready
                    .load(Ordering::Relaxed)
                    && let Some(w) = handle.get_webview_window("main")
                {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let state = window.state::<AppState>();
                if !state.frontend_ready.load(Ordering::Relaxed) {
                    return;
                }
                let pending = state.pending_close.load(Ordering::Relaxed);
                if pending != 0 && now_ms().saturating_sub(pending) > CLOSE_TIMEOUT_MS {
                    return;
                }
                api.prevent_close();
                state.pending_close.store(now_ms(), Ordering::Relaxed);
                let _ = window.emit_to("main", "close-requested", ());
            }
            WindowEvent::DragDrop(drag) => match drag {
                DragDropEvent::Enter { paths, .. } => {
                    let markdown = paths.iter().any(|p| docfs::is_markdown_path(p));
                    let _ = window.emit_to(
                        "main",
                        "drag-state",
                        DragState {
                            active: true,
                            markdown,
                        },
                    );
                }
                DragDropEvent::Drop { paths, .. } => {
                    let _ = window.emit_to(
                        "main",
                        "drag-state",
                        DragState {
                            active: false,
                            markdown: false,
                        },
                    );
                    if let Some(p) = paths.first() {
                        let _ = window.emit_to(
                            "main",
                            "open-file",
                            psymd_core::sanitize::display_path(p),
                        );
                    }
                }
                DragDropEvent::Leave => {
                    let _ = window.emit_to(
                        "main",
                        "drag-state",
                        DragState {
                            active: false,
                            markdown: false,
                        },
                    );
                }
                _ => {}
            },
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to start psy.md");

    app.run(|handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let RunEvent::Opened { urls } = &event {
            let paths: Vec<PathBuf> = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
            if let Some(p) = paths.into_iter().next() {
                let state = handle.state::<AppState>();
                if state.frontend_ready.load(Ordering::Relaxed) {
                    let _ =
                        handle.emit_to("main", "open-file", psymd_core::sanitize::display_path(&p));
                } else if let Ok(mut f) = state.startup_file.lock() {
                    *f = Some(p);
                }
            }
        }
        let _ = (handle, &event);
        if let RunEvent::Exit = event {
            perf::mark("exit", "");
        }
    });
}
