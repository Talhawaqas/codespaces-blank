# Inaya Network dApp Desktop App — Dev Summary

Internal team doc. Not committed to git (matches how we've handled other internal-only summaries — ask before pushing anything like this).

## What it is

`inaya-dapp-desktop/` — a Tauri (Rust) wrapper around the existing main dApp (`https://www.inayanetwork.com/`: faucet, node registry, staking, KYC, referrals, watcher pioneer). Same thin-wrapper philosophy as the Business Workspace desktop app: no new features, same web app, native OS chrome around it (tray, menu, auto-update).

Deliberately a **separate app** from `inaya-desktop/` (Business Workspace) — its own installer, its own identifier (`com.inayanetwork.dapp`), its own signing keypair (`TAURI_SIGNING_PRIVATE_KEY_DAPP`, distinct secret from Business Workspace's). Decided against a single combined app after confirming the user wanted two standalone installers rather than one navigable shell.

## Wallet connectivity — the actual risk this build had to prove out

A native webview has no browser, so MetaMask/Trust/Coinbase (all extension-based) can't work inside it. Confirmed beforehand that WalletConnect (`@walletconnect/ethereum-provider`) was already production-proven via the mobile app's `@reown/appkit-react-native` usage, so the same "no extension" pattern was known to work.

Implementation: `window.__TAURI__` detection in the wallet-picker modal (`inaya-network-dapp/src/app/page.js`). Inside the desktop app, WalletConnect is shown first with a "✓ Recommended for Desktop" badge; MetaMask/Trust/Coinbase are shown disabled with a "✗ Needs browser extension" badge. Outside the desktop app, the picker is unchanged.

**Verified for real**: a genuine WalletConnect QR-code pairing and connection inside the built desktop app, confirmed by the user's own screenshot showing a connected wallet address on the Faucet page.

## What's built and verified

**Window + branding, tray, menu, updater** — same proven patterns as `inaya-desktop/`'s `lib.rs`, adapted: product name "Inaya Network", window title "Inaya Network", `APP_URL` pointed at the live dApp root instead of `/business`. No notifications plugin — there's no "pending approvals" concept on the main dApp, so it was left out rather than carried over unused.

**`on_new_window` → `Allow` popup fix** — reused verbatim from the Business Workspace Google Sign-In fix, since the dApp also has a Google-backed flow (referral/KYC sign-up) that could hit the same WebView2 popup-blocking issue. Carried over defensively; not separately re-proven against a fresh popup bug on this app.

**Installers** — Windows via NSIS, Linux via AppImage + .deb, same as Business Workspace. Windows build done and signed on this machine, smoke-tested with a real install + real WalletConnect connection. Linux built via a new CI workflow, `.github/workflows/build-dapp-desktop-linux.yml` (outer repo root, same reasoning as before — `inaya-dapp-desktop` isn't its own git repo).

**Auto-updater** — `dapp-desktop-latest` fixed GitHub Release tag (deliberately *not* `releases/latest/download/...`). Mid-project we found that `/releases/latest/download/X` resolves repo-wide, not per-product — publishing a release for one Tauri app would silently orphan the other's updater. Business Workspace's `tauri.conf.json` still uses the old collision-prone pattern; **migrating it to a fixed tag (e.g. `desktop-latest`) is a known follow-up, not yet done.**

## Real bug found and fixed before wide release

User reported: Stripe card payment worked, on-chain wallet payment ("PAY & ACTIVATE") did nothing when clicked — no error, no visible failure. Root-caused with real WebView2 remote debugging (`--remote-debugging-port`, connected over CDP, not guessed), two compounding issues:

1. **`ensureCorrectNetwork()` in `page.js`** called `provider.request({ method: 'eth_chainId' }).toLowerCase()`, assuming MetaMask's hex-string return shape. WalletConnect's provider can return this as a `number` instead, which has no `.toLowerCase()` — threw a `TypeError` on every attempt.
2. The resulting `alert()` — this codebase uses raw `alert()` pervasively (60+ call sites) for user-facing errors — was silently swallowed. Tauri's dialog plugin polyfills `window.alert`/`confirm` to route through its native dialog IPC (`plugin:dialog|message`), and the app's `capabilities/default.json` only granted `dialog:default`, which does not cover the `message`/`ask`/`confirm` commands. Net effect: the error genuinely fired, but nothing ever reached the screen — matching the reported "nothing happens" symptom exactly.

Fixed both: `page.js` now normalizes the chain ID to a string regardless of shape; `capabilities/default.json` now explicitly grants `dialog:allow-message`, `dialog:allow-ask`, `dialog:allow-confirm`. Rebuilt, re-signed, and pushed as an update via the `dapp-desktop-latest` release so the already-installed test copy auto-updates. (Business Workspace's `page.js` doesn't use raw `alert()` — checked, zero call sites — so this specific failure mode doesn't affect it.)

## Download page

`/download` was rebuilt into a single combined hub listing **both** desktop apps (dApp + Business Workspace), each with Windows / Linux AppImage / Linux .deb — rather than two separate pages a user has to know to look for. `/business/download` is left in place since existing banners link directly to it.

## Real bug found and fixed: Linux `<select>` orange focus glow

Same root cause and fix as `inaya-desktop/` (see that app's dev summary for the full writeup): WebKitGTK renders `<select>` as a native GTK widget on Linux, including a GTK-theme focus ring our CSS couldn't touch. Fixed once, globally, in `inaya-network-dapp/src/app/globals.css` (`appearance: none` + custom chevron + custom `:focus` ring) — covers this app automatically too since it's the same thin-wrapper-around-the-live-site architecture (`APP_URL` → `https://www.inayanetwork.com/`). No installer rebuild needed; applies on next launch/reload.

## Code signing (Authenticode) — investigated, no free option, deferred to mainnet

Same investigation and same decision as `inaya-desktop/` (full reasoning in that app's dev summary): no free path exists for closed-source software, self-signing wouldn't actually reduce the SmartScreen warning (would have been a fake fix, not implemented), the one real free avenue (SignPath.io Foundation) requires open-sourcing the repo — a business call, not made here — and Azure Trusted Signing (~$10/mo) is the cheapest real paid option if it becomes worth doing before mainnet. Deferred to mainnet per user's call. SmartScreen warning on Windows install remains expected, not a bug.

## Known gaps / not done

- **Linux: CI-compiled and signed only, not run on a real Linux machine.** Same caveat as Business Workspace's Linux build.
- **macOS: not built**, same budget/notarization constraint as before.
- **Not code-signed** (see above) — expected SmartScreen warning on Windows install, by design/deferred.
- **Regression pass is shallow.** Only Network Home and the Faucet tab have actually been exercised inside the desktop wrapper (via the real WalletConnect connection + the wallet-payment bug fix). Node registry, staking, KYC, referrals, and watcher pioneer have not been separately clicked through inside the desktop app.
- **No real auto-update test performed for this app** — unlike Business Workspace, where a full 0.1.0→0.1.1 update round-trip was verified live. The `dapp-desktop-latest` release + `latest.json` are correctly structured (signatures verified byte-for-byte against the actual `.sig` files before upload) but the "does the installed app actually detect and apply it" step hasn't been watched happen.
- **Business Workspace's updater endpoint migration to a fixed release tag is still outstanding**, as noted above.

## Gotcha worth knowing about

The GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY_DAPP` failed signing on its first CI run with `failed to decode secret key: incorrect updater private key password: Missing comment in secret key` — the minisign key file's two-line format (`untrusted comment: ...` header + base64 key) had been mangled, almost certainly from pasting it through GitHub's secret-entry web UI. Fixed by having the user re-set it by piping the raw file bytes directly (`Get-Content -Raw <keyfile> | gh secret set ...`) instead of copy-pasting. Worth doing this for any future multi-line secret to avoid the same failure mode.

## Where things live

- App: `inaya-dapp-desktop/`
- Linux CI: `.github/workflows/build-dapp-desktop-linux.yml` (outer repo root)
- Signing key secret: GitHub repo secret `TAURI_SIGNING_PRIVATE_KEY_DAPP` on `Talhawaqas/codespaces-blank`
- Auto-update release: `github.com/Talhawaqas/codespaces-blank/releases/tag/dapp-desktop-latest`
- Download page: `inaya-network-dapp/src/app/download/page.js` (combined hub, both apps)
- Installer assets served from: `inaya-network-dapp/public/downloads/dapp/` and `.../business-workspace/`
