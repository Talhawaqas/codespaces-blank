// Inaya Business Workspace desktop wrapper.
//
// Deliberately thin: the window just renders the existing web app
// (https://www.inayanetwork.com/business) -- no new features live here,
// only the native-OS integration around it (SOW Section 4): system tray +
// minimize-to-tray, a native application menu, and native notifications
// for pending approvals.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const APP_URL: &str = "https://www.inayanetwork.com/business";

// Injected into the webview before the page loads. Polls the existing
// GET /api/orgs/pending-approvals route (added specifically to support
// this -- see that route's own comment for why it can't reuse
// getAccessibleScope) on the app's own origin, so it rides the same
// session cookie the user is already signed in with; no separate auth
// wiring needed on the Rust side. Only notifies for documents that
// *newly* appear after the first poll, so restarting the app doesn't
// re-notify for everything that's been sitting there for days.
const PENDING_APPROVALS_POLL_SCRIPT: &str = r#"
(function () {
  if (window.__inayaPendingApprovalsPoller) return;
  window.__inayaPendingApprovalsPoller = true;
  var POLL_MS = 60000;
  var seen = new Set();
  var firstPoll = true;
  function poll() {
    fetch('/api/orgs/pending-approvals', { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.documents)) return;
        var newOnes = data.documents.filter(function (d) { return !seen.has(d.id); });
        data.documents.forEach(function (d) { seen.add(d.id); });
        if (!firstPoll && newOnes.length > 0 && window.__TAURI__) {
          window.__TAURI__.core.invoke('notify_pending_approvals', {
            count: newOnes.length,
            filename: newOnes[0].filename,
            orgName: newOnes[0].orgName,
          }).catch(function () {});
        }
        firstPoll = false;
      })
      .catch(function () {});
  }
  poll();
  setInterval(poll, POLL_MS);
})();
"#;

#[tauri::command]
fn notify_pending_approvals(app: tauri::AppHandle, count: u32, filename: String, org_name: String) -> Result<(), String> {
    let body = if count > 1 {
        format!("{} documents awaiting approval, including \"{}\" in {}", count, filename, org_name)
    } else {
        format!("\"{}\" is awaiting your approval in {}", filename, org_name)
    };
    app.notification()
        .builder()
        .title("Inaya Business Workspace")
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// Checked once on startup (not polled -- a business tool people relaunch
// often enough that once-per-launch is sufficient, matching the mobile
// app's OTA approach of checking at app open rather than continuously).
// Prompts before installing rather than installing silently, since
// download_and_install() replaces the running binary and restarts the
// app -- something that shouldn't happen without the user's say-so while
// they might be mid-task.
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
                            "Inaya Business Workspace {} is available. Install and restart now?",
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![notify_pending_approvals])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // ---- Main window ----
            // Built here (rather than declared in tauri.conf.json) so the
            // pending-approvals poller can be injected as an
            // initialization_script -- static window config has no
            // equivalent field for that.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(APP_URL.parse().unwrap()))
                .title("Inaya Business Workspace")
                .inner_size(1280.0, 800.0)
                .resizable(true)
                .initialization_script(PENDING_APPROVALS_POLL_SCRIPT)
                .build()?;

            check_for_updates(app.handle().clone());

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
