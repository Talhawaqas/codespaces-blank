# Inaya Network — Complete Ecosystem Overview

For Talha and co-founder. Every feature below is real and either deployed on testnet or published —
nothing here is a roadmap item unless explicitly marked as such. Contract addresses are BSC Testnet
(chain ID 97) unless stated otherwise. Same "no fake claims" standard as every technical doc in this
repo: if something's partial, aspirational, or a demonstration layer, it says so directly.

---

## 1. Core Storage & Custody

The foundation everything else builds on.

- **Client-side encryption**: AES-GCM-256, PBKDF2 key derivation (100,000 iterations). Your servers
  never see plaintext or the user's key — enforced by architecture, not policy. Three parallel
  implementations (web, SDK, React Native) verified byte-identical.
- **Sharding**: each encrypted file is split into two ciphertext halves ("Shard Alpha"/"Shard
  Beta") — an all-or-nothing 2-of-2 split, not erasure coding. Both are required to reconstruct.
- **Storage**: shards pinned to IPFS via Pinata (primary) and, as of today, **Filebase** (a second,
  independent provider) for real redundancy — see §4.
- **On-chain registry**: `InayaCustody` (`0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888`) registers
  each file's owner, shard CIDs, and size — write-once by design, immutable once registered.
  `InayaNetwork` (`0x9dA15C2908C9A87Ac5af8c116d4092cB6569488e`) is the read-side companion.
- **Metadata layer**: since the on-chain record is immutable, a wallet-signature-authenticated
  off-chain layer handles everything mutable — rename, move, delete/restore, virtual folders,
  and file sharing (X25519 sealed-box key re-wrapping between wallets, not MetaMask's deprecated
  `eth_decrypt`).
- **Analytics**: per-wallet storage statistics, built honestly on what's actually readable
  on-chain — explicitly reports `null` rather than a fabricated number when a real figure isn't
  available (e.g. file size, which `InayaCustody`'s deployed contract doesn't expose on-chain).
- **Proof of storage**: `InayaProofRegistry` (`0xEdF431857e92A00420444F27Ad105278b21CEBcB`) records
  a Merkle root per file and can verify chunk-level proofs against it. Registration is real and
  front-running-protected (cross-checks the real on-chain owner before accepting). **Honest gap**:
  chunk verification itself is still a manual, backend-only tool — there's no automated challenge
  loop yet spot-checking that registered roots match what's actually still on IPFS.

## 2. Multichain / Cross-Chain Bridge

Two independent systems, deliberately never conflated — a chain's status on one says nothing about
the other.

### Native bridge (Inaya's own contracts, full control)
BSC Testnet is home (real $INAYA locked here); every other chain is a spoke that mints/burns a
wrapped representation 1:1 backed by that lock, verified by a 2-of-3 validator threshold signature
scheme shared identically across every chain.

| Chain | Status |
|---|---|
| BSC Testnet (home) | Live, staking-level |
| Ethereum Sepolia | Real transfer proven |
| Avalanche Fuji | Real transfer proven |
| Arbitrum Sepolia | Real transfer proven |
| Solana Devnet | Real transfer proven (custom Anchor program) |
| Hedera Testnet | Real transfer proven (runs the EVM natively — same contracts as BSC/Sepolia/etc.) |
| Aptos Testnet | Real transfer proven (new Move contract) |
| Sui Testnet | Real transfer proven (new Move contract) |

Every entry above has a real, on-chain, verified transaction — bridgeOut on BSC, execution on the
destination, and a confirmed destination balance. None of this is simulated or "should work."

### Wormhole interoperability layer (third-party network, for reach without hand-building every route)
A second, parallel path using Wormhole's Guardian network — doesn't replace the native bridge, adds
a way to reach chains without Inaya building custom contracts for each one.

- **3 real, proven routes**: BSC → Ethereum, Arbitrum, and Avalanche, each a real lock-and-mint
  cycle with a verified destination balance.
- **Solana/Sui/Aptos via Wormhole are blocked** — each for a real, external, specific reason (a
  Wormhole guardian-governance action only they can perform for Solana; a stale, hardcoded SDK
  bytecode reference for Sui and Aptos). This is exactly why we built the native bridges to those
  three chains instead — same outcome, our own infrastructure.

## 3. $INAYA Token & Staking

- `InayaToken.sol`: **30,000,000 hard cap**, enforced in the mint function itself, not just a
  documented intention. 5,000,000 pre-minted at deploy.
- `InayaStaking.sol`: Synthetix-style reward-per-token accounting, three real lock tiers —
  Flexible (1.00x), 30-day (1.25x), 90-day (1.50x) reward multipliers.

## 4. Decentralized Storage Backup & Recovery Mechanism *(new today)*

Closes the redundancy gap in §1: previously, losing either shard's single pin permanently lost the
file. Now:

- Each shard is replicated across two independent pinning providers (Pinata + Filebase).
- Automated two-tier health monitoring: cheap pin-status checks with a 3-strike grace window
  (temporary blips never trigger recovery), plus daily content-hash integrity checks that catch
  real corruption immediately.
- Five backup-health states (Protected/Rebuilding/Degraded/Recovery Required/Recovery Failed),
  visible via `getBackupStatus()`/`getBackupHealth()`.
- Automatic, integrity-verified recovery: fetches from a surviving healthy replica, verifies its
  hash before trusting it, re-pins to restore full redundancy — proven for real today, including a
  genuine simulated-failure-to-recovered cycle with matching on-chain state transitions.
- New `InayaBackupRegistry` contract (`0x062c341aE4f11CB1dEa1B0D3930d52902F97f48a`) records only the
  redundancy commitment and health state on-chain, never the replica data itself.
- **Honest limitation**: this adds redundancy *within* each shard, not across the 2-of-2 split
  itself — losing both shards' entire replica sets independently would still lose the file. Real
  erasure coding would close that gap but is a genuine architecture change, not attempted here.

## 5. Business Workspace

The team/company product built on top of the same core storage.

- **Departments, Projects, Documents** — encrypted document management with approval workflows.
- **CRM** — real contacts and deals pipeline.
- **Procurement & Inventory** — genuinely connected: receiving a purchase order actually moves
  stock.
- **Finance & HR** — labeled and built as a **testnet demonstration/validation layer**, not
  production banking or payroll infrastructure. Visible "Testnet/Beta" badges in the UI itself.
- **Tasks & Approvals** — real workflow primitives underlying the department/project structure.
- **AI Controlled Actions (Guarded Execution / AI Action Requests)** — the `Inaya_AI_Controlled_Actions_SOW.md`
  work: the AI Business Assistant never mutates a record
  directly. It inserts a `PENDING_APPROVAL` request; a human with the *same real permission the
  underlying action would itself require* (not a lesser check) approves or rejects it; an approval
  starts a mandatory 36-hour delay before a separate cron job executes it for real — mirroring
  `InayaNodeRegistry.sol`'s on-chain `queueSettlement → delay → releaseSettlement` pattern,
  reimplemented in MongoDB for these off-chain business operations. An idempotency key
  (org+tool+record+args, hour-bucketed) collapses duplicate proposals, and the executor claims each
  approved request atomically before running it, so overlapping cron runs can't double-execute one.
  Wired for 9 domains as of today — task status, expenses, documents, employees, invoices, leave
  requests, purchase orders, purchase requests, and CRM deals — each risk-classified LOW/MEDIUM/HIGH
  at proposal time, and each unreviewed proposal auto-expires after 7 days if nobody acts on it.
  Every state transition — proposed, approved, rejected, executed, expired, cancelled — is written to
  the audit trail below. Covered by 19 passing tests, including 11 adversarial security scenarios
  (forged confirmation, cross-tenant access, replay, prompt injection, and others) that all fail
  safely. Full phase-by-phase breakdown against the original SOW: `inaya-network-dapp/docs/ai-controlled-actions.md`.
- **Cryptographic Audit Trail** *(new 2026-08-31)* — a tamper-evident hash chain layered on top of
  every org/document activity log: each entry commits to `sha256(prevHash + canonicalFields)`, so
  altering or deleting any past entry breaks every hash after it. `verifyChainIntegrity()` re-walks
  and recomputes the whole chain on demand. A real admin UI (`/admin/audit`) shows a chain browser
  plus a live integrity banner, and `/api/admin/audit/export` exports the full chain as JSON or CSV
  with every field needed to independently recompute and verify it — so a third party doesn't have
  to take Inaya's "Verified" banner on trust. Concurrency-safe under real contention (optimistic
  compare-and-swap on the chain head, retries on conflict, never a corrupted chain). Real, tested
  (`test/audit-chain.test.mjs`), not a stub. Self-service: a business owner/admin can now browse and
  export their own org's chain (JSON/CSV, independently recomputable) from a new "Audit Trail" tab in
  the Business Workspace itself — not just Inaya's internal admin panel.
- **Insights** — read-only KPI aggregation across the workspace, no new writes.
- **Business Brief** *(new today)* — a Daily/Weekly/Monthly/Yearly recap built on the same real
  KPI/comparison data Insights already computes: deterministic highlight bullets (always available,
  no AI dependency) plus a best-effort one-paragraph AI narrative on top, generated only from those
  same real numbers. Available both as a dedicated Workspace view and conversationally through the
  AI Business Assistant ("give me my weekly brief").
- **Billing** — real plan/usage tracking, Stripe-backed checkout for plan changes.
- **NDA-gated Data Room** — separate, access-controlled space for sharing with investors/partners.

## 6. Node Operator Network

- `InayaNodeRegistry` (`0xd12a38e8564d19797B19cF8F80b54DB09B3FD881`) — real commission tiers
  (Entry 30% / Mid 40% / Enterprise 50%), settlement timelocked 36h and callable by anyone once
  unlocked, verifier authority behind a 2-of-3 multisig.
  Governance authority is a real, deployed multisig, not a single admin key.
- `@inaya-network/node-daemon` — published on npm, real CLI (`login`/`register`/`start`/`service
  install`). **Honest scope**: registration, wallet custody, and heartbeat telemetry only — it does
  not store or serve shard data itself (that's the pinning-provider layer in §1/§4).

## 7. Security Layer

A decentralized threat-intelligence firewall, separate from the storage system's own security
model.

- Four real, deployed, verified contracts: `InayaThreatRegistry`, `InayaThreatReporter`,
  `InayaNodeReputation`, `InayaSecurityPolicy`.
- Reputation-weighted confidence threshold before a threat gets confirmed on-chain — not any single
  reporter's word taken at face value.
- Public `/security` page (no login required): AI-assisted security chat, a destination/address
  checker anyone can query, and a live threat feed.
- Desktop app enforces real IP blocks at the OS level (Windows `netsh`/Linux `iptables`).
- Mobile is deliberately **monitor-only** — no VPN or packet interception, an explicit scope
  decision, not an oversight.

## 8. Mobile App (inaya-mobile)

Real screens: Upload, Staking, Bridge, Wallet Balance, My Files, Dashboard, Storage Dashboard,
Faucet, Referral, Node Status, Security (monitor-only), AI Assistant, Knowledge Base,
Notifications, Settings, plus Business Workspace and Learn sections. OTA updates run through a
custom GitHub Actions APK pipeline with a real EAS update channel wired up.

## 9. Desktop Apps

Two separate, real Tauri (Rust) apps — both thin, secure webview wrappers, not reimplementations:

- **Business Workspace desktop app** — tray icon, real push notifications when something needs
  your approval (polls the real approvals API), auto-updates itself. Verified on real Windows
  hardware with a real version-to-version update.
- **Main dApp desktop app** — wraps the core storage product, connects via WalletConnect (native
  webviews can't run browser extensions like MetaMask).

Both ship for Windows (fully verified on real hardware) and Linux (CI-built and signed, not yet
run on real Linux hardware). Not code-signed yet — deferred to mainnet.

## 10. Payments, Billing, Referrals, CRM

Real backend routes, Stripe-backed where money moves: card/PAYG checkout, egress-unlock checkout,
org billing/plan management, and a full referral lifecycle (initiate → activate → history →
leaderboard → redeem), including a real incoming webhook.

## 11. Developer Ecosystem — the custody-sdk monorepo

`@inaya-network/custody-sdk` — the SDK everything above is ultimately built on, published to npm
(`1.0.7-beta`, currently both `beta` and `latest`). Six independent client modules: Crypto,
On-chain (Custody + Staking), Payments, Metadata, Analytics, and — new today — **Backup**
(redundancy status/health/recovery). Plus three more published packages in the same monorepo:
`@inaya-network/react` (drop-in UI components, live Storybook), `inaya-cli` (terminal/CI tool,
verified with a real end-to-end round trip), and `create-inaya-dapp` (project scaffolding, both
templates verified). `node-daemon` (§6) is the fourth published package.

## 12. Web3 App Store, NFT Vault & Wallet Protection *(new today)*

Three additions to the core dApp, deliberately scoped after checking what genuinely already existed
(none of the three had any prior code anywhere in the repo) and confirming with the team which
version of each was worth building today versus a separate, larger effort later.

- **Web3 App Store** (`/apps`) — a curated directory of Inaya's own real, shipped applications
  (Vault, NFT Vault, Bridge, Business Workspace, Security Center, Data Room, Stats, Automation
  Status), each linking to how it's independently verifiable (on-chain contract data, a hash chain,
  proven bridge routes) rather than a fabricated trust score. **Deliberately not** an open
  third-party dApp marketplace — that needs a real submission/review and sandboxing security model
  that doesn't exist yet, confirmed as out of scope for this pass, not silently built smaller than
  asked.
- **NFT Vault** (`/nfts`) — discovers the NFTs a connected wallet owns from a specific ERC-721 +
  Enumerable collection on BSC Testnet (real on-chain `balanceOf`/`tokenOfOwnerByIndex`/`tokenURI`
  calls, no indexer credentials configured so auto-discovery-across-everything is an honestly stated
  gap, same "ships real, provider-agnostic pieces stubbed until credentials arrive" pattern the
  Backup mechanism's Filebase integration started with), then backs each NFT's metadata + image up
  to Inaya's own encrypted storage — reusing the exact same AES-GCM-256 encrypt/shard/pin pipeline
  every other upload in this app already uses, not a new crypto path. A backup record requires BOTH
  a wallet signature (the same generic signing framework the file-sharing metadata routes already
  use) AND a real on-chain `ownerOf()` check against the claimed address — you can't record a backup
  for an NFT you don't actually own.
- **In-app wallet-attack protection** — a real standalone browser extension doesn't exist anywhere
  in the repo and isn't a small addition (new codebase, build tooling, store review/signing,
  content-script injection into arbitrary pages), so rather than build that, the existing, real
  Security Layer threat registry is now wired directly into the Bridge page's recipient-address
  field: type or paste a destination address and it's checked (debounced) against the same live
  registry `/security`'s public checker uses, with a clear warning for a CONFIRMED or DISPUTED
  report and honest silence for "no data on file" — never a fabricated safety guarantee. Verified
  live end-to-end (seeded a real confirmed threat record, watched the warning render with the
  correct category, watched an unknown address stay silent).
- **Secured community App Store hosting** *(new today)* — developers can now list their own apps
  via two vetted paths: an already-pinned IPFS CID (opens through a public gateway in a new tab,
  never touches Inaya's own origin) or an externally-hosted URL shown in a strictly sandboxed
  iframe (`sandbox="allow-scripts allow-forms allow-popups"` — deliberately never combined with
  `allow-same-origin`, the actual dangerous pairing). Same-origin hosting of third-party code and an
  unvetted open registry were both explicitly considered and rejected. Every submission requires a
  real wallet signature, is checked against the live Security Layer threat registry both at
  submission and again at review time, and starts `pending` — nothing is ever auto-published; an
  admin reviews and approves through a new passphrase-gated queue at `/admin/app-store`, the same
  session pattern the audit-chain admin page already uses. Verified end-to-end with a real signed
  submission, a reject/approve cycle, and three adversarial cases (malformed CID, a `javascript:`
  URL scheme, a forged wallet signature) — all correctly rejected. Two real bugs caught and fixed
  during that verification: the App Store page was being statically pre-rendered at build time
  (new approved listings would never have appeared until the next deploy), and a URL-normalization
  mismatch between the signed message and the stored value was incorrectly flagging legitimate
  submissions as tampered.
- **Host apps via the SDK/CLI** *(new today)* — the App Store submission above isn't web-only
  anymore. A new `InayaKernel.AppStore` client (`submitListing`/`getListings`/`getMyListings`) lets
  any Node script submit or check a listing programmatically, and a new `inaya deploy <path>` CLI
  command does the whole "static site → live submission" flow in one command: pins a local build
  directory to IPFS as a single directory CID via the developer's OWN Pinata account (never proxied
  through Inaya's own backend — no new upload surface on Inaya's infrastructure), then submits it
  through the exact same reviewed, threat-checked pipeline as every other submission. Real safety
  guards run on the local directory before anything is pinned (symlink/path-traversal escape
  rejected, `node_modules`/`.git`/`.env*` excluded by default, a 1000-file/150MB hard cap) — proven
  against a real symlink and real oversized-directory cases, not just asserted. 39 tests across the
  SDK and the CLI's first-ever test suite, all passing. **Honest gap**: no `PINATA_JWT` was
  available this session to prove the live multi-file Pinata pin round trip end-to-end — the whole
  pipeline is verified up to that exact boundary, real credentials needed for the last mile.

## 13. MFA for Business Workspace *(new today)*

Two-step verification, fully opt-in, web + mobile — a member who never enrolls sees zero change to
their login. Two methods: **TOTP** (scan a QR code with Google Authenticator, Authy, or any
standard RFC 6238 authenticator app) and **SMS**. Identity-scoped by email, not org-scoped, so one
enrollment protects every company a person belongs to, not just the one they set it up from.

- **New reversible server-side encryption** (`mfaCrypto.js`, AES-256-GCM) — confirmed nothing like
  it existed anywhere in the app before; every other server-side secret here was one-way hashed,
  which is right for a session token but wrong for a TOTP secret the server must decrypt on every
  login. Everything else (recovery codes, SMS OTPs, the login-pending token) stays one-way hashed,
  same minimal-trust convention as the rest of the codebase.
- **Real brute-force guard**: a login's second-factor attempt is capped at 5 tries before the
  pending login is invalidated outright — the control that actually matters against a 6-digit
  code's 1-in-1,000,000 space.
- **Disabling MFA always requires a live code first** — never a bare toggle.
- SMS now runs on **real Firebase Phone Auth**, not a generic SMS-send provider — after Twilio and
  AWS SNS both hit onboarding friction, the SMS method was rebuilt on Firebase's own client-driven
  verification flow: the browser (Firebase's JS SDK + invisible reCAPTCHA) sends and checks the code
  directly with Firebase, and the server only ever independently re-verifies the resulting signed ID
  token (`firebaseAdmin.js`, never trusted blind) before recording a phone number as proven. The
  earlier Twilio/AWS SNS adapters (`smsProviders/twilio.js`, `awsSns.js`) stay in the repo, real and
  tested, but are unwired now that Firebase is the active mechanism.
- 14 tests, covering both factors: TOTP using **real otpauth-generated codes**, SMS using a stubbed
  ID-token verifier (a real Firebase ID token needs a live project to produce) — full
  enroll→login-verify flow for each, the 5-attempt lockout, recovery-code single-use, and encryption
  tamper detection.
- Mobile reuses the same web-bounce mechanism already proven for Google Sign-In (`GoogleSignInButton`
  in `BusinessAuthScreen.js`): a "Verify via Web" button opens a session-free web page
  (`/mfa/phone-auth`) that runs the real Firebase flow in a real browser context, then bounces back
  into the app via its own custom URL scheme carrying the ID token — no native Firebase SDK added,
  consistent with every other auth flow in the app. TOTP enrollment stays identical to web,
  reusing the exact same backend, zero new API surface beyond the SMS method's own change.

## 14. Sovereign Enterprise OS — the connecting layer *(new today)*

Most of what this SOW asked for already existed (Business Workspace, AI Guarded Execution, the
audit trail, the App Store, custody-sdk) — what was actually missing was the layer that connects
all of it into one coherent "operating environment" rather than a pile of separate features. Built
on **both** surfaces (Business Workspace, org/email-identity, and the main dApp, wallet-identity) as
two parallel instances sharing the same underlying engines, since those two identity systems are
genuinely separate today (no `walletAddress` field exists anywhere on an org membership record) —
confirmed before building anything, not assumed.

- **Identity Context** — neither surface had a client-side identity context before today; both
  prop-drilled session/wallet state through one giant top-level component. New `OrgContext`/
  `WalletContext` (React Context, mirroring the app's one prior Context, `ThemeProvider`) now make
  "current org" / "current wallet" reachable from any component via `useOrg()`/`useWallet()` with
  zero props threaded through. The org-side permission gates (`canManageOrg`, `canManageFinance`,
  etc.) were extracted into a new client-safe module (`orgGates.js`) so they could be imported here
  at all — the file they used to live in pulls in `node:crypto`/MongoDB, which can't ship to a
  browser bundle. Every one of the ~60 existing server-side call sites keeps working unchanged via
  a re-export.
- **Cross-Module Trust & Health** — confirmed nothing anywhere combined audit-chain integrity, AI
  action backlog, backup health, and security status into one signal (grepped for
  `trustScore`/`systemHealth`/`aggregat*` — zero hits). New `computeTrustHealthSnapshot()` does this
  for real, per scope: org-side combines `verifyChainIntegrity()`, pending AI actions by risk tier,
  and overdue business items (platform-wide security stats are labeled as such, not presented as
  org-specific, since there's genuinely no org↔security linkage yet); wallet-side combines the
  wallet's own recent security events with real per-asset backup health across its own files — a
  cleaner signal than the org side, since security/backup data is naturally wallet-keyed already.
- **Unified Notifications** — the only prior "notifications" were a narrow referral/KYC read-model
  with no database collection at all (computed on every read) and unread state tracked only in
  `localStorage`. New `notifications`/`notification_reads` collections with real, persistent
  read-state, and real write-hooks from AI action proposals/decisions, document-approval
  submissions, and backup state-change events — not just plumbing with nothing feeding it.
- **Unified Search** — the only real search anywhere was a scoped YouTube proxy for the Learn video
  library. New Cmd/Ctrl+K search reuses `getAccessibleScope()` as its only data source on the org
  side (so a result can never leak something the caller couldn't already see), and the wallet's own
  vault files on the dApp side.
- **Activity Center ("What Changed?")** — a periodic cross-module digest, distinct from the existing
  raw chronological activity log. Composes the real, already-shipped Business Brief output plus new
  genuine period-over-period counts (AI action outcomes, notification volume) — trust/health is
  reported as current-state, deliberately not framed as a delta, since nothing persists historical
  snapshots to honestly diff against yet.
- **OS-Level AI Assistant** — a thin dispatch router, not a new AI system: merges the existing
  Business + Security tool sets (org side) or a new `search_docs` tool (wrapping the same RAG
  retrieval the Docs Assistant already uses) + Security (wallet side) behind one conversation, with
  tool-name prefixing so Gemini sees one collision-free tool list and each call routes straight into
  the real, unmodified existing tool dispatchers. Verified live with real Gemini round-trips, not
  just unit tests: asked it "What is Inaya?" and "any recent security events?" in the same session
  and got correctly-grounded, correctly-labeled answers from both underlying tool sets.
- **OS Home** — the actual "at a glance" screen tying all of the above together, real data only
  (no new aggregate backend needed — parallel fetches against the APIs above). Wired as Business
  Workspace's new default view (safe — that surface is always-authenticated already) and as a new
  "OS Home" tab on the dApp (deliberately *not* the default there — that page is the public landing
  page for anonymous, no-wallet visitors too, and replacing it would break that entry point).
- **Desktop multi-window** — both desktop apps could only ever open a single window before today.
  New `open_module_window` Tauri command (identical implementation in both apps) lets a module
  (Audit Trail, AI Action Requests, App Store, Security) "pop out" into its own real native window
  running alongside the main one. Verified for real, not just type-checked: `cargo check` passed on
  both crates, then a genuine `cargo build --release` succeeded for both, producing real standalone
  portable `.exe` files (no installer needed, same pattern §9's desktop apps already use), and both
  apps' existing Linux CI workflows ran green on the actual push.

## 15. Healthcare & Legal OS Expansion *(new today)*

Extends the Sovereign Enterprise OS (§14) into two vertical specializations — **Health OS** and
**Legal OS** — for organizations handling patient or client/matter data, on Business Workspace's
existing org/email identity side only (no dApp/wallet-side work here). Reuses the shared OS
foundation throughout (`getAccessibleScope()`, the audit chain, notifications, unified search) —
confirmed via codebase audit before writing anything, not assumed.

- **Assignment-based access, not department-based** — patient/matter visibility is a genuinely
  different model from every other Business Workspace module: department membership grants
  nothing here. Only an explicit care-team or matter-team assignment (or an org-wide `healthRole`/
  `legalRole`) grants visibility — verified by tests confirming a department member with no
  assignment sees zero patients/matters, even though they can see everything else in that
  department.
- **Break-glass emergency access, done safely** — a real, time-limited care-team assignment (not a
  separate bypass code path), audited the instant it's granted and requiring manager review
  afterward. Caught a real bug while testing this: the first version had no expiry enforcement in
  the visibility query, so a "4-hour" grant would have stayed active forever — fixed and reverified.
- **Legal holds that actually block deletion** — not a UI warning. `checkDispositionAllowed()` is a
  real guard verified to return `allowed:false` for any record tied to a matter under an active
  hold, and `allowed:true` again once released — tested both directions.
- **Trust accounting with one hard safety rule** — client trust-fund withdrawals can never exceed a
  matter's real computed balance, checked atomically before every withdrawal. No jurisdictional
  (IOLTA-style) compliance is claimed or attempted — this is a financial-safety guard, not a
  regulatory one.
- **AI kept deliberately narrow** — both the Health OS and Legal OS AI tool sets are 100% read/
  summarize/draft, with zero tools that mutate a clinical record, release a hold, or delete
  evidence — those capabilities simply aren't exposed, rather than trusted to a prompt-level
  instruction. A free-text query framed as a diagnosis request, a request for final legal advice, or
  a request to release a hold or delete evidence is refused at the tool layer before any
  summarization runs — verified with real refusal tests, not just instructions.
- **The vertical lock is real, not cosmetic** — an org's configured business type (`general` /
  `healthcare` / `legal`, picked at signup or changed later in Settings) isn't just a hidden nav
  item: every one of the 25 Health/Legal API routes independently rejects a mismatched org with a
  403, verified with real HTTP requests against three live seeded orgs (a healthcare org's calls
  succeed, a general or legal org's identical calls are cleanly rejected, never served). A real bug
  surfaced building this — several POST handlers referenced a variable that didn't exist in that
  scope, a guaranteed crash on every call — caught by a permanent new test before it shipped, not
  after.
- **No compliance certification exists or is claimed anywhere** — HIPAA Security Rule and ABA
  Model Rule references in this build are explicitly design references, per the SOW's own
  instruction, never a claim of certification, audit, or legal compliance.

**UI status *(updated today)*** — every domain module across both verticals now has a real screen,
not just Patients and Matters: Health OS covers appointments, consent, release-of-information,
billing, care-team assignment, emergency-access review, and research datasets inside Patient 360;
Legal OS covers matter team, deadlines, evidence custody, legal holds, discovery, redaction,
contracts, time & billing, and trust accounting inside the Matter Workspace, plus Clients,
Prospects, and Corporate Entities as their own tabs. Live-verified end-to-end against the running
app, including watching the trust ledger correctly reject an overdraft withdrawal with a clear
on-screen error. Mobile now has its own screens too (Health OS, Legal OS, and their patient/matter
detail screens), gated the same way as web so a general or wrong-vertical org never sees the
button — written and syntax-verified, but not yet opened on an actual device or simulator.
FHIR/HL7/e-filing/e-signature/SSO and every other third-party integration remain documented
adapter interfaces with an honest `configured:false` stub, not live integrations — none of these
can be genuine without the user's own third-party credentials.

## 16. Other real, notable features

- **Watcher Pioneer program** — a real enrollment/qualification/status API exists for it.
- **Public, real deployed-contracts panel** on the landing page — anyone can independently verify
  the Core Custody Contract address and status live, not take our word for it.
- **Hackathon infrastructure** — real bug-report and winner-tracking routes from a past hackathon
  program.

---

## The honest through-line

Every "real" claim above traces to an actual on-chain transaction, a deployed contract address, a
published npm package, or a passing test suite — the same discipline `docs/chain-agnostic-audit.md`
established early on and every subsequent piece of work in this codebase has held to since. Where
something is a demonstration layer (Finance/HR) or has an explicit scope boundary (mobile security
monitor-only, manual-only chunk verification), that's stated in the product itself, not just in
this doc.
