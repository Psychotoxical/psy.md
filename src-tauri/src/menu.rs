//! Native menu. macOS expects one (the Edit menu also enables copy and paste
//! shortcuts in the webview); Windows and Linux use the in-window controls.

use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const EN: &str = include_str!("../../src/i18n/en.json");
const DE: &str = include_str!("../../src/i18n/de.json");

fn strings(lang: &str) -> (Value, Value) {
    let en: Value = serde_json::from_str(EN).unwrap_or(Value::Null);
    let local = if lang == "de" {
        serde_json::from_str(DE).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    (local, en)
}

fn label(t: &(Value, Value), key: &str) -> String {
    t.0.get(key)
        .or_else(|| t.1.get(key))
        .and_then(Value::as_str)
        .unwrap_or(key)
        .to_owned()
}

pub fn build<R: Runtime>(app: &AppHandle<R>, lang: &str) -> tauri::Result<Menu<R>> {
    let t = strings(lang);
    let l = |k: &str| label(&t, k);
    let item =
        |id: &str, key: &str, accel: Option<&str>| MenuItem::with_id(app, id, l(key), true, accel);

    let app_menu = Submenu::with_items(
        app,
        "psy.md",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&l("menu.about")), None)?,
            &PredefinedMenuItem::separator(app)?,
            &item("settings", "menu.settings", Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&l("menu.hide")))?,
            &PredefinedMenuItem::hide_others(app, Some(&l("menu.hideOthers")))?,
            &PredefinedMenuItem::show_all(app, Some(&l("menu.showAll")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&l("menu.quit")))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        l("menu.file"),
        true,
        &[
            &item("open", "menu.open", Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("save", "menu.save", Some("CmdOrCtrl+S"))?,
            &item("save-as", "menu.saveAs", Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(&l("menu.close")))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        l("menu.edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&l("menu.undo")))?,
            &PredefinedMenuItem::redo(app, Some(&l("menu.redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(&l("menu.cut")))?,
            &PredefinedMenuItem::copy(app, Some(&l("menu.copy")))?,
            &PredefinedMenuItem::paste(app, Some(&l("menu.paste")))?,
            &PredefinedMenuItem::select_all(app, Some(&l("menu.selectAll")))?,
            &PredefinedMenuItem::separator(app)?,
            &item("find", "menu.find", Some("CmdOrCtrl+F"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        l("menu.view"),
        true,
        &[
            &item("view-preview", "view.preview", Some("CmdOrCtrl+1"))?,
            &item("view-split", "view.split", Some("CmdOrCtrl+2"))?,
            &item("view-source", "view.source", Some("CmdOrCtrl+3"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("contents", "menu.contents", Some("CmdOrCtrl+Shift+T"))?,
            &PredefinedMenuItem::separator(app)?,
            &item("zoom-in", "menu.zoomIn", Some("CmdOrCtrl+="))?,
            &item("zoom-out", "menu.zoomOut", Some("CmdOrCtrl+-"))?,
            &item("zoom-reset", "menu.zoomReset", Some("CmdOrCtrl+0"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        l("menu.window"),
        true,
        &[&PredefinedMenuItem::minimize(
            app,
            Some(&l("menu.minimize")),
        )?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

/// Installs the localized menu on macOS; elsewhere nothing happens.
pub fn install<R: Runtime>(app: &AppHandle<R>, lang: &str) {
    if cfg!(target_os = "macos")
        && let Ok(menu) = build(app, lang)
    {
        let _ = app.set_menu(menu);
    }
}

pub fn forward_events<R: Runtime>(app: &AppHandle<R>) {
    app.on_menu_event(|app, event| {
        let _ = app.emit_to("main", "menu-action", event.id().0.clone());
    });
}
