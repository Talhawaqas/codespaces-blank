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
use keyring::Entry;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

const APP_URL: &str = "https://www.inayanetwork.com/";
const TRUSTED_ORIGIN: &str = "https://www.inayanetwork.com";

// SECURITY: defense-in-depth for the passkey commands below -- see inaya-desktop's src/lib.rs
// (the sibling Business Workspace wrapper)'s identical verify_trusted_origin for the full
// reasoning: Tauri v2's capabilities/ACL system is designed primarily around plugin commands,
// so whether capabilities/default.json's `remote.urls` actually gates a bare #[tauri::command]
// like these is ambiguous without a live runtime test. This window always loads APP_URL and
// never navigates anywhere else, so checking the calling window's actual URL here fails closed
// regardless of how that ACL ambiguity resolves.
fn verify_trusted_origin(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let origin = format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""));
    if origin != TRUSTED_ORIGIN {
        return Err(format!("Refusing: this command is only callable from {}, not {}.", TRUSTED_ORIGIN, origin));
    }
    Ok(())
}

// User-Controlled Master Node Passkey Backup & Recovery (SOW section 1,
// "Local Secure Storage") -- the actual OS-backed credential store
// (Windows Credential Manager / Linux Secret Service via libsecret), not
// Tauri's own Stronghold vault: Stronghold would need its own separate
// password to manage, which is redundant with the backup password the
// encrypted-export flow (page.js, custody-sdk/src/passkeyBackup.js)
// already asks for. These three commands are the entire native surface
// for this feature -- the encryption/decryption of the *backup file* all
// happens in the webview via passkeyBackup.js; this only stores/retrieves
// the plaintext passkey locally so a user doesn't have to re-type it
// every session. The passkey never leaves this device either way.
const KEYRING_SERVICE: &str = "com.inayanetwork.dapp";
const KEYRING_ACCOUNT: &str = "master-node-passkey";

#[tauri::command]
fn store_passkey_secure(window: tauri::WebviewWindow, passkey: String) -> Result<(), String> {
    verify_trusted_origin(&window)?;
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .and_then(|e| e.set_password(&passkey))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn retrieve_passkey_secure(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    verify_trusted_origin(&window)?;
    match Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).and_then(|e| e.get_password()) {
        Ok(passkey) => Ok(Some(passkey)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn clear_passkey_secure(window: tauri::WebviewWindow) -> Result<(), String> {
    verify_trusted_origin(&window)?;
    match Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Enterprise OS SOW, Phase 9 — multi-window support, identical
// implementation to inaya-desktop's own open_module_window (see that
// file's comment for the full reasoning): parameterizes the same
// WebviewWindowBuilder::new(app, label, WebviewUrl::External(...)) call
// the main window below is already built with, reuses the same
// verify_trusted_origin guard, re-focuses an existing pop-out instead of
// erroring on a duplicate label.
#[tauri::command]
fn open_module_window(app: tauri::AppHandle, window: tauri::WebviewWindow, label: String, path: String) -> Result<(), String> {
    verify_trusted_origin(&window)?;

    if label.is_empty() || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Refusing: label must be non-empty alphanumeric/dash/underscore only.".into());
    }
    if !path.starts_with('/') {
        return Err("Refusing: path must be a relative path starting with '/'.".into());
    }

    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let full_url = format!("{}{}", TRUSTED_ORIGIN, path);
    // Not naming the error type explicitly (e.g. url::ParseError) since
    // the `url` crate is only a transitive dependency here, not a direct
    // one in Cargo.toml -- see inaya-desktop's identical open_module_window
    // for the full reasoning.
    let parsed_url = match full_url.parse() {
        Ok(u) => u,
        Err(e) => return Err(format!("{:?}", e)),
    };
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed_url))
        .title("Inaya Network")
        .inner_size(1000.0, 700.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

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
        .invoke_handler(tauri::generate_handler![
            store_passkey_secure,
            retrieve_passkey_secure,
            clear_passkey_secure,
            open_module_window
        ])
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
