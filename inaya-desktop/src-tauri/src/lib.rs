// Inaya Business Workspace desktop wrapper.
//
// Deliberately thin: the window just renders the existing web app
// (https://www.inayanetwork.com/business) via tauri.conf.json's windows[0].url --
// no new features live here, only the native-OS integration around it (SOW
// Section 4): system tray + minimize-to-tray, a native application menu, and
// (once wired) native notifications for pending approvals.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ---- System tray ----
            // A business tool people may realistically want running in the
            // background (checking for approvals, etc.) without a taskbar
            // window open at all times -- see SOW Section 4.
            let show_item = MenuItem::with_id(app, "show", "Show Inaya", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click the tray icon itself (not the menu) also shows
                    // the window -- the common "click the tray icon to bring the
                    // app back" convention most tray apps follow.
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ---- Native application menu ----
            // Platform-appropriate: a File menu with Quit, an Edit menu with the
            // standard copy/paste/undo set (the web app has real text inputs --
            // document titles, comments, search -- so native Edit shortcuts and
            // right-click behavior should work like any other desktop app), and
            // a View menu with reload/zoom, all via Tauri's PredefinedMenuItem so
            // the actual OS-native behavior is used rather than reimplementing it.
            let file_menu = Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?, &PredefinedMenuItem::quit(app, None)?],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let reload_item = MenuItem::with_id(app, "reload", "Reload", true, None::<&str>)?;
            let view_menu = Submenu::with_items(app, "View", true, &[&reload_item])?;
            let app_menu = Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu])?;
            app.set_menu(app_menu)?;
            app.on_menu_event(move |app, event| {
                if event.id() == "reload" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.location.reload()");
                    }
                }
            });

            Ok(())
        })
        // ---- Minimize-to-tray ----
        // Closing the window (the X button) hides it instead of quitting the
        // process -- the app keeps running in the tray, same as most
        // background-capable desktop tools. Only the tray menu's "Quit" (or
        // Cmd/Ctrl+Q via the native File menu) actually exits.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
