# Mobile OTA Update Fix — Dev Summary

Internal team doc. Not committed to git (matches how we've handled other internal-only summaries).

## What went wrong

Earlier work (previous session) added EAS Update (OTA) support to `inaya-mobile` and shipped a
KYC-resume fix via `eas update --branch production`, reporting it as live. It was not — the
installed app had no way to receive it, and this wasn't caught before being reported as fixed.

Today, when asked to OTA-publish a roadmap content change the same way, the same gap surfaced
again in front of the user, this time after they'd already told their own users it was fixed.
That's a legitimate, serious miss — reporting "live" without verifying delivery end-to-end.

## Root cause (two separate, compounding gaps)

`inaya-mobile` doesn't distribute via `eas build` — it uses its own GitHub Actions pipeline
(`.github/workflows/build-apk.yml`) that runs `expo prebuild` + a direct Gradle
`assembleRelease`. `eas build` normally does two things automatically that this pipeline never
did:

1. **Client-side: no channel embedded in the APK.** `eas build` auto-injects an
   `expo-channel-name` request header into the compiled app based on the build profile's
   `channel` in `eas.json`. A raw `expo prebuild` + Gradle build does not — `app.json`'s
   `updates` block had no `requestHeaders`, so the installed APK had literally no channel to
   present when checking for updates, regardless of restarts.
2. **Server-side: no channel ever created.** `eas update --branch production` creates a
   **branch**, not a **channel** — those are distinct EAS concepts, linked via a
   channel→branch mapping. `eas channel:list` came back empty: zero channels had ever existed
   for this project. Even after fixing gap #1, the update server would have had no channel
   named "production" to resolve the header against — confirmed directly via
   `curl` against `u.expo.dev` with the exact headers the app sends, which returned
   `404: There is no channel named production for the app with ID: ...` before the fix.

Either gap alone would have caused today's exact symptom. Both had to be fixed for OTA to work
at all.

## Fix

1. **`inaya-mobile/app.json`** — added:
   ```json
   "updates": {
     "url": "https://u.expo.dev/d3ab3b26-0be8-4082-9f01-45a7b90d8f56",
     "requestHeaders": { "expo-channel-name": "production" }
   }
   ```
   This is the documented way to wire a channel for non-`eas build` pipelines. Committed as
   `7d61485`, pushed to `main`, which auto-triggered a new `build-apk.yml` run (run
   [32312518496](https://github.com/Talhawaqas/inaya-mobile/actions/runs/32312518496)) —
   embedding this config requires a real rebuild since it's compiled into the native manifest,
   not something `eas update` itself can patch retroactively.
2. **`eas channel:create production`** — created the missing channel and linked it to the
   existing `production` branch (confirmed via CLI output: "Created update channel 'production'
   ... connected it with existing 'production' branch").

## Verification (all real, not assumed)

Given the exact failure mode last time was reporting "live" without confirming delivery, this
was verified at every layer before saying anything was fixed:

1. **Local `expo prebuild --platform android --clean`**, then direct inspection of the
   generated `AndroidManifest.xml` — confirmed
   `expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY` =
   `{"expo-channel-name":"production"}`, `EXPO_UPDATE_URL` correct, and
   `expo_runtime_version` string resource = `1.0.0` (matching the runtime version on the
   published update).
2. **Server-side manifest resolution**, simulated with a raw `curl` presenting the exact
   protocol headers the native `expo-updates` client sends
   (`expo-protocol-version`, `expo-platform: android`, `expo-runtime-version: 1.0.0`,
   `expo-channel-name: production`) — before the channel existed: `404`. After creating it:
   `200 OK`, `expo-update-id` matching the actual published Android update ID, `expo-manifest-
   filters: branchname="production"`, real manifest JSON body.
3. **The real compiled artifact**, not the local prebuild copy — downloaded the actual
   `app-release.apk` produced by the passing CI run
   ([32312518496](https://github.com/Talhawaqas/inaya-mobile/actions/runs/32312518496)),
   extracted `AndroidManifest.xml` from the APK zip, and confirmed byte-for-byte that
   `{"expo-channel-name":"production"}`, the correct update URL, and
   `EXPO_UPDATES_CHECK_ON_LAUNCH` are present in the shipped binary.

**What is still not verified**: actually installing this APK and watching a real device fetch
and apply the update. No Android SDK/emulator/ADB is available in this environment. Config-level
and server-level verification are as complete as they can be without a physical or emulated
device — that last step needs a real install.

## Commits

| Repo | Commit | What |
|---|---|---|
| `inaya-mobile` | `7d61485` | Add `expo-channel-name: production` request header to `app.json` |
| EAS (not a commit) | — | Created `production` channel, linked to `production` branch |

## Process takeaway

The failure here wasn't the OTA setup itself — it was reporting something as "live" based on a
successful CLI publish command, without checking whether the installed app's build pipeline
could actually receive it. Going forward for this project: any claim that a fix is "live" on
mobile needs the manifest-resolution check (or better, a real device test) before saying so,
not just a successful `eas update` exit code.
