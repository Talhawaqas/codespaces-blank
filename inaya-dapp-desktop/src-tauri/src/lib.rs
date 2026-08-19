// Inaya Network dApp desktop wrapper.
//
// Deliberately thin: the window just renders the existing dApp
// (https://www.inayanetwork.com/) -- no new features live here, only the
// native-OS integration around it: system tray + minimize-to-tray, a
// native application menu, and auto-update.
//
// Wallet connection: this app has no browser-extension ecosystem (unlike
// a real browser), so MetaMask/Trust/Coinbase's window.ethereum path is a
// dead end here. The dApp's own wallet picker (src/app/page.js in
// inaya-network-dapp) already detects window.__TAURI__ and leads with
// WalletConnect in that case -- nothing to do on the Rust side for that,
// same as the Business Workspace app didn't need any Google-Sign-In-
// specific Rust code beyond the generic popup handler below.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

const APP_URL: &str = "https://www.inayanetwork.com/";

// Checked once on startup. Prompts before installing rather than
// installing silently, since download_and_install() replaces the running
// binary and restarts the app.
fn check_for_updates(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                log::error!("updater unavailable: {e}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let app_for_dialog = app.clone();
                let answer = tauri::async_runtime::spawn_blocking(move || {
                    app_for_dialog
                        .dialog()
                        .message(format!(
                            "Inaya Network {} is available. Install and restart now?",
                            version
                        ))
                        .title("Update available")
                        .buttons(MessageDialogButtons::YesNo)
                        .blocking_show()
                })
                .await
                .unwrap_or(false);

                if answer {
                    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                        log::error!("update install failed: {e}");
                    } else {
                        app.restart();
                    }
                }
            }
            Ok(None) => {}
            Err(e) => log::error!("update check failed: {e}"),
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ---- Main window ----
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(APP_URL.parse().unwrap()))
                .title("Inaya Network")
                .inner_size(1280.0, 800.0)
                .resizable(true)
                // Same fix as the Business Workspace app: WebView2 refuses
                // window.open() (Google Sign-In's popup, WalletConnect's
                // QR modal is same-page so this mostly matters for Google)
                // unless something handles the request. Allow uses Tauri's
                // default popup creation, preserving window.opener.
                .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Allow)
                .build()?;

            check_for_updates(app.handle().clone());

            // ---- System tray ----
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
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
