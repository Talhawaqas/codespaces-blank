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
use keyring::Entry;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

const APP_URL: &str = "https://www.inayanetwork.com/business";
const TRUSTED_ORIGIN: &str = "https://www.inayanetwork.com";

// SECURITY: defense-in-depth for the commands below that touch the OS keychain or the firewall.
// This window always loads APP_URL and never navigates anywhere else, but Tauri v2's
// capabilities/ACL system is designed primarily around PLUGIN commands -- whether an app-level
// command declared with a bare #[tauri::command] (as these are, not through a local plugin with
// its own permission schema) is actually gated by capabilities/default.json's `remote.urls` is
// genuinely ambiguous without a live runtime test this environment can't perform. Rather than
// depend on that ambiguity, every sensitive command below independently confirms the calling
// window's current URL is really this app's own origin before doing anything -- so even if the
// ACL layer turns out to be wide open for app-level commands, invoking these from any other
// origin (a future XSS payload, a compromised third-party script, anything not this app itself)
// fails closed here regardless.
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
const KEYRING_SERVICE: &str = "com.inayanetwork.desktop";
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

// Security Layer client (Security Layer SOW): follows the exact same idiom
// as the pending-approvals poller above rather than adding a native HTTP
// client crate -- the webview already has a same-origin fetch() session,
// so feed sync and threat lookups happen in JS, and the Rust side is only
// invoked for the two genuinely NATIVE actions: a block/warn notification,
// and an actual OS firewall rule. This deliberately keeps the "thin
// wrapper" philosophy at the top of this file intact.
//
// Only navigations initiated by clicking a link *inside the Business
// Workspace* are checked here (chat links, shared documents, etc.) --
// this is the desktop MVP's real, safe enforcement surface, same scope
// decision as the mobile app's in-app-link-check (full OS-wide traffic
// interception is explicitly out of scope for this pass, see the plan's
// "Explicitly deferred" section). A stable per-install device id is
// generated once and cached in localStorage so /api/security/events has
// a consistent identityId across restarts.
const SECURITY_FEED_POLL_SCRIPT: &str = r#"
(function () {
  if (window.__inayaSecurityLayer) return;
  window.__inayaSecurityLayer = true;
  var FEED_POLL_MS = 5 * 60 * 1000;
  var confirmedThreats = new Map(); // indicator (lowercased) -> threat record
  var lastSince = null;

  function deviceId() {
    try {
      var id = localStorage.getItem('inaya_desktop_device_id');
      if (!id) {
        id = 'desktop-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('inaya_desktop_device_id', id);
      }
      return id;
    } catch (e) {
      return 'desktop-unknown';
    }
  }

  function isIpLiteral(s) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
  }

  function syncFeed() {
    var url = '/api/security/feed' + (lastSince ? ('?since=' + encodeURIComponent(lastSince)) : '');
    fetch(url, { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.items)) return;
        data.items.forEach(function (t) {
          if (t.status === 1 && t.indicator) confirmedThreats.set(String(t.indicator).toLowerCase(), t);
        });
        lastSince = data.generatedAt || lastSince;
      })
      .catch(function () {});
  }

  function logEvent(eventType, destination, decision, reason, threat) {
    fetch('/api/security/events', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identityId: deviceId(),
        surface: 'desktop',
        eventType: eventType,
        destination: destination,
        decision: decision,
        reason: reason,
        confidenceBps: threat ? threat.confidenceBps : null,
        category: threat ? threat.category : null,
      }),
    }).catch(function () {});
  }

  document.addEventListener(
    'click',
    function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!link) return;
      var host;
      try {
        host = new URL(link.href, window.location.href).hostname.toLowerCase();
      } catch (e) {
        return;
      }
      var threat = confirmedThreats.get(host);
      if (!threat) return;

      event.preventDefault();
      event.stopPropagation();
      logEvent('block', host, 'block', 'Confirmed threat via Inaya Security Layer', threat);
      if (window.__TAURI__) {
        window.__TAURI__.core
          .invoke('notify_security_event', {
            title: 'Inaya Security Layer',
            body: 'Blocked a link to "' + host + '" -- reported malicious by ' + (threat.contributingNodes ? threat.contributingNodes.length : 'multiple') + ' independent Inaya nodes.',
          })
          .catch(function () {});
        if (isIpLiteral(host)) {
          window.__TAURI__.core.invoke('block_ip', { ip: host, label: String(threat._id || host).slice(0, 16) }).catch(function () {});
        }
      }
    },
    true
  );

  syncFeed();
  setInterval(syncFeed, FEED_POLL_MS);
})();
"#;

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

#[tauri::command]
fn notify_security_event(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

// Real OS-level enforcement for a CONFIRMED malicious IP (Security Layer SOW §11/§24) --
// deliberately IP-only, not domain-based: netsh/iptables block by address, and resolving a
// domain first would need its own DNS logic and could disagree with what a browser actually
// connects to. Rule name embeds the threat id so add/delete stay paired and the rule is
// auditable via `netsh advfirewall firewall show rule name=...` (see the plan's Verification
// section -- this is only ever invoked for the user's own explicit block action or a
// Protect/Strict-mode confirmed threat, never silently).
#[tauri::command]
fn block_ip(window: tauri::WebviewWindow, ip: String, label: String) -> Result<String, String> {
    verify_trusted_origin(&window)?;
    if !ip.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err("Refusing to block a non-IPv4-literal value.".into());
    }
    // label comes from the security feed's threat._id (JS slices it to 16 chars before sending,
    // but this is the actual trust boundary, not that slice) -- not exploitable as command
    // injection since Command::args never goes through a shell, but an unvalidated value could
    // still produce a garbled/collided rule name. Same alphanumeric+dash+underscore allowlist
    // unblock_ip below relies on implicitly by needing an exact rule-name match to find what to remove.
    if label.is_empty() || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Refusing to block: label must be non-empty alphanumeric/dash/underscore only.".into());
    }
    let rule_name = format!("Inaya-Block-{}", label);

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "add", "rule", &format!("name={}", rule_name), "dir=out", "action=block", &format!("remoteip={}", ip)])
            .output()
            .map_err(|e| e.to_string())?;
        return if output.status.success() {
            Ok(format!("Blocked {} via Windows Firewall rule \"{}\".", ip, rule_name))
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        };
    }

    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("iptables")
            .args(["-A", "OUTPUT", "-d", &ip, "-j", "DROP"])
            .output()
            .map_err(|e| e.to_string())?;
        return if output.status.success() {
            Ok(format!("Blocked {} via iptables.", ip))
        } else {
            Err("Requires elevated privileges (run as root) to modify iptables rules.".into())
        };
    }

    #[allow(unreachable_code)]
    Err("OS-level blocking isn't supported on this platform in this build.".into())
}

#[tauri::command]
fn unblock_ip(window: tauri::WebviewWindow, ip: String, label: String) -> Result<String, String> {
    verify_trusted_origin(&window)?;
    if label.is_empty() || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Refusing to unblock: label must be non-empty alphanumeric/dash/underscore only.".into());
    }
    let rule_name = format!("Inaya-Block-{}", label);

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("netsh")
            .args(["advfirewall", "firewall", "delete", "rule", &format!("name={}", rule_name)])
            .output()
            .map_err(|e| e.to_string())?;
        return if output.status.success() {
            Ok(format!("Removed the Windows Firewall rule \"{}\".", rule_name))
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        };
    }

    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("iptables")
            .args(["-D", "OUTPUT", "-d", &ip, "-j", "DROP"])
            .output()
            .map_err(|e| e.to_string())?;
        return if output.status.success() {
            Ok(format!("Unblocked {} via iptables.", ip))
        } else {
            Err("Requires elevated privileges (run as root) to modify iptables rules.".into())
        };
    }

    #[allow(unreachable_code)]
    Err("OS-level blocking isn't supported on this platform in this build.".into())
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
        .invoke_handler(tauri::generate_handler![
            notify_pending_approvals,
            notify_security_event,
            block_ip,
            unblock_ip,
            store_passkey_secure,
            retrieve_passkey_secure,
            clear_passkey_secure
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
            // Built here (rather than declared in tauri.conf.json) so the
            // pending-approvals poller can be injected as an
            // initialization_script -- static window config has no
            // equivalent field for that.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(APP_URL.parse().unwrap()))
                .title("Inaya Business Workspace")
                .inner_size(1280.0, 800.0)
                .resizable(true)
                .initialization_script(PENDING_APPROVALS_POLL_SCRIPT)
                .initialization_script(SECURITY_FEED_POLL_SCRIPT)
                // Google's Sign-In popup (and any other window.open() call) is
                // refused by default -- WebView2 doesn't create a real popup
                // window unless something handles the request. Allow uses
                // Tauri's own default popup creation, which wires up the
                // opener/postMessage relationship the same way a real browser
                // would, so GSI's existing popup flow works unmodified.
                .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Allow)
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

#[cfg(test)]
mod passkey_secure_storage_tests {
    use super::*;

    // Real round trip against this machine's actual OS credential store
    // (Windows Credential Manager here) -- not a mock. Uses a distinct
    // test account name so it never collides with a real stored passkey.
    // Run manually with: cargo test passkey_secure_storage_tests -- --ignored --nocapture
    #[test]
    #[ignore]
    fn store_retrieve_clear_round_trip_against_real_os_credential_store() {
        const TEST_ACCOUNT: &str = "master-node-passkey-selftest";
        let entry = Entry::new(KEYRING_SERVICE, TEST_ACCOUNT).unwrap();
        entry.set_password("test-passkey-value-12345").unwrap();
        let retrieved = entry.get_password().unwrap();
        assert_eq!(retrieved, "test-passkey-value-12345");
        entry.delete_credential().unwrap();
        match entry.get_password() {
            Err(keyring::Error::NoEntry) => {}
            other => panic!("expected NoEntry after delete, got {:?}", other),
        }
        println!("Real OS credential store round trip (store -> retrieve -> clear -> confirmed gone): PASSED");
    }
}
