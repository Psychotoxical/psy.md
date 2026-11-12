/// Every command the frontend may call. Each gets an `allow-…` permission that
/// the main window's capability grants explicitly.
const COMMANDS: &[&str] = &[
    "load_state",
    "save_settings",
    "save_session",
    "open_document",
    "close_document",
    "render_markdown",
    "save_document",
    "pick_open_file",
    "pick_save_path",
    "resolve_link",
    "open_external",
    "set_external_images",
    "grant_folder",
    "frontend_ready",
    "close_ack",
    "confirm_close",
    "set_window_theme",
    "set_title",
    "set_language",
    "perf_mark",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
