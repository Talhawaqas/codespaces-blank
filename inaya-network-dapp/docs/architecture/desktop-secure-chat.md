# Secure Chat in the desktop app (Competitive Expansion SOW A9 and section 40)

Scope: `inaya-desktop`, the Business Workspace desktop app. `inaya-dapp-desktop` is the wallet dApp wrapper and is not a chat surface, so it was deliberately left alone. Both apps are a native window around the hosted web app, so every web screen (chat, notes, shares, governance, devices, gateway, secure viewer) is already inside the desktop window once the site is deployed and the organization has the feature on.

## What the desktop app adds

| Need | How it works |
|---|---|
| Standalone chat window | A button, visible only inside the desktop app, calls the app's existing `open_module_window` command with `/business?view=chat` |
| One window owns the chat | A Web Lock names the owner window per person and organization. A second window shows "Secure Chat is open in another window" and a button; pressing it asks the owner (BroadcastChannel) to finish its current update and let go, then takes over. Two windows never run the same device at once. Handoff takes a few seconds (up to one 15 s update), measured at 12 s in a hidden tab |
| Alerts while in the tray | The sync loop keeps running when the desktop window is hidden (an ordinary browser tab still pauses). When the unread total grows and the window is hidden or unfocused it calls `notify_chat_message` with a **number only**; the alert reads "You have N unread secure messages." It never contains a name, a title or text |
| Tray tooltip | `set_chat_unread` updates the tray icon tooltip with the unread total |
| Device identity | The device enrolls as "Desktop app" with its real platform (windows, macos or linux); it shows in the device list and can be revoked like any device |
| Encrypted local cache | The same sealed browser store the web app uses (AES-GCM, wrap key in the window's own storage); nothing is written as plaintext |
| Attachment picker | The web file picker works inside the window |
| Online and offline | An "Online / Offline" pill in chat and a banner across the Business Workspace while the device has no network. Messages written offline are kept on the device and sent on reconnect (existing outbox) |
| Local cache controls | "Erase message history on this device" (keeps the device working; erased history cannot be fetched again) and "Remove this device from Secure Chat" (revokes it and erases every key and cache), plus a storage-used figure (everything Inaya stores in that window, not chat alone) |
| Secure sign-out | Organization policy `signOutPolicy`: **keep** (default), **clear** (erase message history on the device), **revoke** (revoke the device and erase everything). Applied to every organization the person belongs to when they press Sign out, while the session still exists. Owners and admins set it in the chat policy panel |

## Honest limits

- The native alert and tray code was compiled and its text logic unit-tested (`cargo test chat_alert_tests`); the web side was run in a real browser with a stand-in for the native bridge and the three native calls were observed. It has **not** been run inside a real desktop window, because that needs the web release deployed and a new desktop build.
- A native alert cannot be clicked to open a conversation; the plugin used does not report clicks. The tray icon opens the app.
- Not built: smart-sync placeholder files with sync-state overlays, and a native cache manager beyond the chat buttons.
- The one-owner guard relies on the Web Locks API, present in the app's web engine and in current browsers. Where it is missing the guard is skipped.
- If the owner window is closed or crashes mid-update the lock is released by the browser; a second window then starts normally.
