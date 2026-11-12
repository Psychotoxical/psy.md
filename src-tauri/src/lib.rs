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

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, DragDropEvent, Emitter, Manager, RunEvent, WindowEvent};
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

/// The files in a command line (the first entry is the program), with
/// relative paths taken from the folder the command was started in.
fn file_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .collect()
}

/// Opens files as tabs: at once if the interface runs, else at its start.
fn open_files(app: &AppHandle, files: Vec<PathBuf>) {
    let state = app.state::<AppState>();
    if state.frontend_ready.load(Ordering::Relaxed) {
        for p in files {
            let _ = app.emit_to("main", "open-file", psymd_core::sanitize::display_path(&p));
        }
    } else if let Ok(mut f) = state.startup_files.lock() {
        f.extend(files);
    }
}

pub fn run() {
    perf::init();
    let state = AppState::default();
    if let Ok(mut f) = state.startup_files.lock() {
        let cwd = std::env::current_dir().unwrap_or_default();
        *f = file_args(
            std::env::args_os().map(|a| a.to_string_lossy().into_owned()),
            &cwd,
        );
    }

    let app = tauri::Builder::default()
        // First, so a second start hands its files over before anything else runs.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            open_files(app, file_args(args, Path::new(&cwd)));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
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
            commands::set_active,
            commands::reveal_document,
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
                    // Every Markdown file becomes a tab; without any, the first
                    // path still goes through so the reason is shown.
                    let markdown: Vec<PathBuf> = paths
                        .iter()
                        .filter(|p| docfs::is_markdown_path(p))
                        .cloned()
                        .collect();
                    let files = if markdown.is_empty() {
                        paths.iter().take(1).cloned().collect()
                    } else {
                        markdown
                    };
                    for p in files {
                        let _ = window.emit_to(
                            "main",
                            "open-file",
                            psymd_core::sanitize::display_path(&p),
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
            open_files(handle, paths);
        }
        let _ = (handle, &event);
        if let RunEvent::Exit = event {
            perf::mark("exit", "");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn a_second_start_hands_over_all_its_files() {
        let cwd = Path::new("work");
        let files = file_args(args(&["psymd", "a.md", "--flag", "sub/b.md"]), cwd);
        assert_eq!(files, [cwd.join("a.md"), cwd.join("sub/b.md")]);
    }

    #[test]
    fn absolute_paths_stay_as_given() {
        let abs = std::env::temp_dir().join("c.md");
        let files = file_args(args(&["psymd", &abs.to_string_lossy()]), Path::new("work"));
        assert_eq!(files, [abs]);
    }

    #[test]
    fn a_start_without_files_opens_nothing() {
        assert!(file_args(args(&["psymd"]), Path::new("work")).is_empty());
    }
}
