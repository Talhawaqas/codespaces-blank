# Verifiable Inaya Client & Content-Addressed Delivery

Internal architecture doc for the SOW `Inaya_Verifiable_Client_Content_Addressed_Delivery_SOW.md`.
Same honesty convention as `docs/ai-controlled-actions.md`: every claim below cites a real file,
real function, or a real passing test — nothing here is aspirational, and anything genuinely
deferred is labeled as such rather than implied to exist.

Core principle (the SOW's own words):

> Users should not have to blindly trust client code simply because it was delivered by Inaya
> infrastructure.

## The problem this closes

`@inaya-network/custody-sdk` was already public on GitHub and npm, but it was **not** what
actually ran for most web users. The real AES-GCM-256/PBKDF2/2-of-2-sharding code lived as two
independent, duplicated `crypto.subtle` implementations inside this app itself
(`src/lib/clientCrypto.js` and `src/app/page.js`'s own inline copy), neither importing the SDK —
in fact custody-sdk's `crypto.js` was originally *ported from* `page.js`, not the other way
around. Verifying the SDK's source, in that state, wouldn't have actually verified what protects
a file on upload here.

## Integration diagram (the SOW's own, annotated with what implements each stage)

```
Source Code                    → github.com/Talhawaqas/custody-sdk (public)
    ↓
Reproducible Build              → No build step exists (src/*.js ships as-is) — see
                                   custody-sdk/docs/VERIFYING_RELEASES.md
    ↓
Published Hash                  → custody-sdk/CHECKSUMS.md, per release
    ↓
Independent Verification        → anyone: clone at tag, hash it themselves, compare
    ↓
Verified Client                 → InayaKernel.deriveVaultKey / disperseAndSlice /
                                   reconstructAndDecrypt (custody-sdk/src/crypto.js)
    ↓
AES-GCM-256 Encryption          → same as before, now via the SDK instead of an inline copy
    ↓
2-of-2 Sharding                 → disperseAndSlice()'s midpoint split, unchanged behavior
    ↓
Decentralized Storage           → Pinata (+ Filebase replica) pinning, unchanged
```

## What changed here, concretely

### Crypto consolidation

- `custody-sdk/src/index.js`: `reconstructAndDecrypt` — already implemented and used
  internally by `retrieveAndReconstruct()` — is now exposed on `InayaKernel` and as a
  named export. Purely additive; nothing that already used the SDK needed a signature
  change.
- `src/lib/clientCrypto.js`'s `encryptAndShardFile()` now calls
  `InayaKernel.generateSecureSalt`/`deriveVaultKey`/`disperseAndSlice` directly instead of
  a hand-rolled `crypto.subtle` copy. Used by `src/components/business/FinanceView.js`,
  `HRView.js`, `src/app/business/page.js`, `src/app/nfts/page.js`, and
  `src/app/api/nft/backup/route.js` (indirectly, via the shared function) — none of these
  call sites needed to change, only the function's internals.
- `src/app/page.js`: `prepareShardedFile()`, `handleCardUpload()`, and both
  `InayaKernel.reconstructAndDecrypt()` retrieval call sites now run through the SDK. The
  dead local `encryptData`/`decryptData`/`readFileAsDataURL` closures were removed after
  confirming (via repo-wide grep) nothing else referenced them.

### Proving the swap didn't break anything

This is the one change in the whole SOW with a real data-loss risk: get it wrong, and an
existing user's already-encrypted file becomes permanently undecryptable the moment a
live call site switches implementations. Two independent layers of proof, both real:

1. **`custody-sdk/test/webCryptoCompat.test.mjs`** — a committed, automated test suite
   (not a comment claim) proving the SDK's `@noble/`-based crypto and a byte-for-byte
   mirror of the dApp's `crypto.subtle` implementation produce **identical ciphertext**
   for identical inputs (fixed salt/IV), and are cross-decryptable in both directions
   across several payload sizes including the exact midpoint-split boundary. Includes a
   frozen regression fixture — a real, independently-produced ciphertext hardcoded as a
   literal (not regenerated at test-run time from the same code under test), so a future
   change that broke compatibility on both sides identically still gets caught. All tests
   pass.
2. **Live browser verification**: the actual webpack-bundled `InayaKernel` (reached via
   the dev server's own module cache, not a synthetic environment) was exercised directly
   in a real browser — encrypt → shard → reconstruct → decrypt round-tripped byte-perfect,
   and a wrong passkey was correctly rejected (AEAD tamper detection intact). Confirms the
   `@noble/*` primitives, which are pure JS with no environment-conditional code paths
   beyond the base64 encode/decode helpers, execute correctly in a real browser and not
   just in Node.

### Release verification infrastructure (custody-sdk)

No build step exists for this package (`src/*.js` ships as-is, hand-written `.d.ts`), so
"reproducible build" reduces to a much simpler, stronger claim than usual: *the published
npm tarball is provably and exactly the tagged git source.*

- `custody-sdk/.github/workflows/release.yml` — triggered on `v*` tags: runs the test
  suite, computes a git-tree SHA-256 and an npm-tarball SHA-256, publishes to npm with
  `--provenance` (OIDC-attested, checkable via `npm audit signatures`), records both
  hashes in `CHECKSUMS.md`, and attaches everything to a GitHub Release. Fails the release
  if `CHANGELOG.md` wasn't updated for the tag, so "publish exact source/version per
  release" (SOW item 3) stays enforced, not just documented.
- `custody-sdk/CHANGELOG.md`, `CHECKSUMS.md`, `docs/VERIFYING_RELEASES.md` — the release
  history and the exact third-party reproduction command sequence.
- `custody-sdk/package.json`'s `files` allowlist (`src`, `README.md`, `LICENSE`) — the
  published tarball used to ship the entire monorepo (~125 files); now it ships only what
  the package actually is.

### Content-addressed delivery

- `custody-sdk/packages/cli/src/pinDirectory.js`'s `pinDirectoryToIPFS()` already existed
  (built for `inaya deploy`, pinning a static site) but had never been verified end-to-end
  against a real Pinata account — `custody-sdk/packages/cli/test/pinDirectory.integration.test.mjs`
  closes that gap, skipped automatically when no `PINATA_JWT` is set so it never blocks
  CI for contributors without Pinata credentials. **Still needs a real, manual run against
  a live Pinata account before the release workflow's pin step is fully trusted in
  production** — flagged here rather than silently assumed working.
- `custody-sdk/scripts/pin-release.mjs` — reuses that same function to pin every release
  tarball, using Inaya's own `INAYA_RELEASE_PINATA_JWT` (deliberately separate from an
  end-developer's own JWT used by `inaya deploy`). The resulting CID lands in
  `CHECKSUMS.md` and the GitHub Release. Single-provider (Pinata only, no Filebase
  redundancy) — a deliberate, documented choice: this is a small, low-volume release
  artifact, not user data, so the uptime-redundancy story that matters for file storage
  (`src/backup.js`) isn't proportionate here. That's this SOW's "or a documented reason it
  isn't practical" escape hatch for the redundancy question specifically, not for
  content-addressing itself (which is implemented).
- What the CID actually proves: fetch it from any public IPFS gateway (not from a server
  Inaya controls), hash what you get, compare to the git-tree/npm hashes independently
  computed from the tagged source — or just re-pin the identical tarball bytes yourself
  with any IPFS tool and confirm you get the same CID back. A CID is derived from content,
  so that second path is what actually makes "the address identifies the exact artifact"
  true, rather than "Inaya says so."

### Web app build traceability

- `next.config.mjs`: `generateBuildId()` now returns `<git-sha>-sdk<resolved-sdk-version>`
  instead of Next's default random UUID-per-build. The resolved SDK version is read from
  `node_modules/@inaya-network/custody-sdk/package.json` (the actual installed version),
  not the semver range string in this app's own `package.json`. Exposed client-side via
  `NEXT_PUBLIC_BUILD_ID`/`NEXT_PUBLIC_SDK_VERSION`.
- `src/app/build/page.js` — a "Verify this build" section displays both values and links
  to this doc and to `custody-sdk`'s own verification guide.
- `src/app/download/page.js` — each desktop-binary download card shows a `sha256sum`
  verify hint when `public/downloads/CHECKSUMS.txt` has a matching entry (parsed at
  runtime, not hardcoded — a hash baked into page source would go stale the moment a new
  binary is built).

### Mobile and desktop

- `inaya-mobile/.github/workflows/build-apk.yml` — the existing raw-Gradle release build
  (kept, rather than switching to EAS Build, to avoid disturbing the keystore pinning that
  keeps Google Sign-In's OAuth fingerprint stable) now computes the APK's SHA-256 and
  publishes it to a GitHub Release on version tags, closing the gap where the admin
  dashboard already sums GitHub Releases download counts for `.apk` assets but nothing
  previously put them there.
- `.github/workflows/build-desktop-linux.yml` / `build-dapp-desktop-linux.yml` — pin
  `SOURCE_DATE_EPOCH` to the commit timestamp, add `--remap-path-prefix` and an exact
  pinned Rust toolchain (previously floating on `stable`), and compute SHA-256 checksums
  for the AppImage/.deb outputs, written to `public/downloads/CHECKSUMS.txt`. Deliberately
  **not** chasing full bit-for-bit binary reproducibility (would need a hermetic, pinned
  build environment — disproportionate for what these apps are, see below) — this closes
  the cheap, common sources of non-determinism (timestamps, absolute paths, toolchain
  drift) without that larger undertaking.
- Both `inaya-desktop` and `inaya-dapp-desktop` are thin Tauri wrappers that load
  `https://www.inayanetwork.com` remotely (`WebviewUrl::External` — confirmed in both
  `src-tauri/src/lib.rs`) — there is no bundled frontend of substance. This means
  "verifying the desktop client" genuinely splits into two different things:
  - **The native binary itself** — a real, achievable reproducible-build target (100% of
    its source is in this repo), and `tauri-plugin-updater` already verifies binary origin
    via minisign signing on every auto-update.
  - **The remote web content it renders at runtime** — entirely inherits whatever this
    doc's web-app verification story is. The desktop shell has no mechanism today to pin,
    display, or attest which web build version it's currently showing. Don't read a
    verified desktop binary as proof the content it's displaying right now was verified —
    it wasn't, independently, by the desktop app itself.

## What this guarantees

- The code that produced a given `custody-sdk` release is exactly the tagged source in
  the public repository — provable by anyone, not asserted on trust.
- The published hashes (git-tree, npm-tarball, IPFS CID) are all independently
  re-derivable.
- As of this SOW, the SDK's crypto is the **same code path** running for web
  (`inaya-network-dapp`) and mobile (`inaya-mobile`) uploads — not a separate,
  unverified web implementation running alongside a verified-but-unused SDK.
- The web-crypto consolidation was proven safe via a committed cross-implementation
  compatibility test plus live-browser verification, not assumed safe because the
  primitives are "standard."

## What this does NOT guarantee

- That the live `inayanetwork.com` deployment is running this exact verified build at
  this exact moment. The build-ID display (`/build`) is traceability, not proof — it
  tells you what the server *claims* to be running; it doesn't independently confirm the
  server is being honest about it. Closing that gap fully would need something like
  signed build manifests served over a channel a client can verify without trusting the
  same server — not built here, and worth naming as a real limitation rather than
  glossing over it.
- That the desktop apps' remotely-loaded content matches what was verified above — see
  the desktop section.
- An implementation-bug-free audit of the underlying cryptographic primitives (PBKDF2,
  AES-GCM) beyond the cross-implementation compatibility testing in Phase 0/`webCryptoCompat.test.mjs`
  — that test proves the two implementations agree with each other, not that either is
  free of a deeper cryptographic flaw.
- Anything about mainnet security. This SDK, and the network it talks to, are
  testnet-stage today — the same caveat the FAQ already states elsewhere applies here too.

## Explicitly deferred / not in this pass

- Full bit-for-bit Rust binary reproducibility for the desktop apps (would need a
  hermetic pinned build environment — Nix or an equivalently pinned container image).
  `SOURCE_DATE_EPOCH`/`--remap-path-prefix`/pinned-toolchain gets the cheap wins; chasing
  the rest wasn't judged proportionate for what is, per the section above, a thin native
  shell around remotely-loaded content.
- iOS build automation for mobile — there's no existing iOS pipeline to harden in the
  first place; building one from scratch is new infrastructure, not "make an existing
  thing verifiable."
- Multi-provider (Pinata + Filebase) redundancy for pinning official SDK releases — a
  deliberate, documented scope decision (see "Content-addressed delivery" above), not an
  oversight.
- A signed-build-manifest mechanism that would let a client verify server honesty without
  trusting the server — named above as a real gap in what build-ID traceability can prove,
  not attempted in this pass.
