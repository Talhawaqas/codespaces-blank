# Inaya Desktop App — Dev Summary

Internal team doc. Not committed to git (matches how we've handled other internal-only summaries — ask before pushing anything like this).

## What it is

`inaya-desktop/` — a Tauri (Rust) wrapper around the existing Business Workspace web app (`https://www.inayanetwork.com/business`). Deliberately thin: no new features, same web app, native OS chrome layered around it (tray, menu, notifications, auto-update).

Chose Tauri over Electron after measuring both on this machine: 8.3MB installed vs 269MB for an equivalent Electron build, because Tauri rides the OS's own WebView2 (Windows) / WebKitGTK (Linux) instead of bundling Chromium.

## What's built and verified

**Window + branding** — `src-tauri/src/lib.rs`, `tauri.conf.json`. Product name "Inaya Business Workspace" (controls Start Menu entry, installer name). Icons regenerated from the real logo (`inaya-mobile/assets/icon.png`), not the Tauri scaffold default.

**System tray + minimize-to-tray** — closing the window hides it instead of quitting; tray icon click restores it. Verified via a real Win32 `WM_SYSCOMMAND`/`SC_CLOSE` simulation and a real user click (confirmed via debug logging showing the actual `TrayIconEvent::Click` firing).

**Native File/Edit/View menu** — standard `PredefinedMenuItem`s, plus a Reload item.

**Native notifications for pending approvals** — new backend route `GET /api/orgs/pending-approvals` (inaya-network-dapp). This does NOT reuse `getAccessibleScope()` — approval authority is purely org-role-based (`canManageOrg`, owner/admin only) per `document-workflow.js`, so a member who can merely *see* a pending doc has no power to act on it and would get a meaningless notification. The desktop app injects a polling script (`initialization_script` on the `WebviewWindowBuilder`) that hits this endpoint every 60s using the user's existing session cookie — no separate auth wiring needed. New items trigger a real Windows toast via `tauri-plugin-notification`. Verified with a real toast landing in Action Center.

**Auto-updater** — `tauri-plugin-updater`, checks once per launch, confirms via native dialog before installing. Signing keypair generated via `tauri signer generate` (interactive password prompt — this CLI reads directly from the Windows console handle, not redirected stdin, so it has to be run in a real terminal, not scripted). Private key: `src-tauri/inaya-desktop-updater.key` (gitignored, local only). Public key is embedded in `tauri.conf.json`. Update manifest hosted via GitHub Releases (`releases/latest/download/latest.json`) on the existing `Talhawaqas/codespaces-blank` repo — no new infra. Verified with a **real** test: published a signed 0.1.1 release, the installed 0.1.0 build detected it, downloaded, installed, and relaunched as 0.1.1.

**Google Sign-In popup fix** — real bug, not a config issue. WebView2 silently refuses `window.open()` unless something handles the request; Google's own client-side log showed `Failed to open popup window... Maybe blocked by the browser?` on every click (confirmed via WebView2 remote debugging — `--remote-debugging-port`, connected over CDP). Fix: `.on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Allow)` on the `WebviewWindowBuilder` — lets Tauri's default popup handling take over, which preserves the `window.opener` relationship GSI's flow depends on. Verified end-to-end with a real Google account through actual 2FA and into the real dashboard.

**Installers** — Windows via NSIS (`tauri.conf.json` bundle targets `nsis`, `appimage`, `deb`). Verified full round-trip on this machine: silent install → Start Menu shortcut + registry uninstall entry created → launches correctly → silent uninstall removes everything cleanly.

Linux (AppImage + .deb) built via a new GitHub Actions workflow (`.github/workflows/build-desktop-linux.yml`, lives at the **outer repo root**, not nested under `inaya-desktop/` — `inaya-desktop` isn't its own git repo, unlike `inaya-mobile`, so GitHub Actions won't scan a nested `.github/workflows/`). Uses the same `TAURI_SIGNING_PRIVATE_KEY` secret as Windows. **Not run on a real Linux machine** — compiled clean in CI, that's the extent of verification. Treat as materially less proven than Windows until someone actually runs it.

## Real bug found and fixed: Linux `<select>` orange focus glow

User (real Linux machine) reported dropdowns — the document visibility selector in particular — rendering with a thick orange/amber halo that looked like a validation error, even on fields that weren't required or touched yet. Root cause: WebKitGTK (the engine both this app and the dApp desktop app run on via Tauri, on Linux only) renders `<select>` as a native GTK widget by default, including the GTK theme's focus ring, which our Tailwind border/shadow classes never touch because the browser hands the whole element over to the native toolkit to draw.

Fixed globally in `inaya-network-dapp/src/app/globals.css`: `appearance: none` on `select` forces WebKitGTK to let CSS render it instead, plus a hand-rolled chevron background-image since the native arrow disappears along with the native chrome, and a custom `:focus` box-shadow to replace the lost native focus indicator.

This app doesn't bundle any frontend code — `frontendDist` is a blank placeholder, and `lib.rs`'s `APP_URL` just points the webview at `https://www.inayanetwork.com/business` — so the fix applies to every installed copy automatically on next launch/reload, no new installer build required. Same fix also covers `inaya-dapp-desktop/` for the same reason (see its own dev summary).

## Code signing (Authenticode) — investigated, no free option, deferred to mainnet

User asked for a free way to Authenticode-sign the Windows installer to remove the SmartScreen "unknown publisher" warning, without spending money yet. Researched honestly rather than reaching for something that looks like a fix but isn't:

- **No free path exists for a closed-source/proprietary app.** Every commercial CA (DigiCert, Sectigo, SSL.com, etc.) charges for an Authenticode certificate — OV certs run roughly $70–500/yr depending on vendor, EV more.
- **Self-signing does not help.** A self-signed certificate isn't in Windows' trusted root store on end-user machines, so SmartScreen still flags the binary as unrecognized — it would just replace "Unknown Publisher" with an unverified name, no reputation benefit, and risks looking *more* suspicious (an unverifiable claimed identity) rather than less. Deliberately not implemented for this reason — would have been a fake fix.
- **SmartScreen's own reputation-building doesn't meaningfully help here either.** Reputation accrues per file hash for unsigned binaries, and since every new release rebuilds the installer (new hash), reputation effectively resets on every version bump — it never accumulates the way it does for a persistently-signed publisher identity.
- **One genuine free avenue exists but isn't a code change**: [SignPath.io's Foundation program](https://signpath.io/) provides free Authenticode signing for qualifying **open-source** projects (public repo, OSI-approved license, passes their vetting). This would require actually open-sourcing the desktop app repo(s) — a licensing/business decision, not something to flip on unilaterally.
- **Cheap (not free) option for later**: Microsoft's own [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) runs about $10/month once past initial identity verification — worth a look before a traditional yearly cert if/when signing becomes worth paying for.

**Decision**: deferred, per user — will revisit for mainnet launch rather than spend on it now. The SmartScreen warning on the Windows installer remains expected/known behavior until then; download page copy already sets this expectation ("Windows may show a SmartScreen warning since this build isn't code-signed yet").

## Known gaps / not done

- **Linux: genuinely untested beyond compiling** at the time this was originally written; the `<select>` fix above was diagnosed and fixed from a real user report, but a full regression pass on real Linux hardware still hasn't happened.
- **macOS: dropped entirely**, per budget constraint (Apple Developer Program $99/yr + notarization). Windows + Linux only.
- **Not code-signed** (see above) — expected SmartScreen warning on Windows install, by design/deferred, not a bug.
- Full regression pass covered magic-link + Google sign-in, department/project/document CRUD, permissions grant, secure share-link creation, and the AI Assistant — all through the desktop wrapper, all against real backend data. Did not exercise every corner (bulk operations, org switching, billing flows) inside the desktop app specifically — those are exercised elsewhere (web/mobile) and the wrapper doesn't touch that code.

## Gotcha worth knowing about

Claude Code (this assistant) runs inside its own Windows app-container sandbox. Installers run through its own tool calls get silently redirected into a private `AppData\Local` copy — invisible to a normal user's Start Menu/Explorer, which is why an early install showed a blank Start Menu icon. Real installs need to be run by an actual human in their own session, not scripted through the assistant. Every verification claim above that involved installing (not just running an already-open dev binary) was re-confirmed after a real, human-run install.

## Where things live

- App: `inaya-desktop/`
- Backend endpoint: `inaya-network-dapp/src/app/api/orgs/pending-approvals/route.js`
- Linux CI: `.github/workflows/build-desktop-linux.yml` (outer repo root)
- Signing key secret: GitHub repo secret `TAURI_SIGNING_PRIVATE_KEY` on `Talhawaqas/codespaces-blank`
- Latest test release: `github.com/Talhawaqas/codespaces-blank/releases/tag/desktop-v0.1.1` (marked as a test release, not GA)
