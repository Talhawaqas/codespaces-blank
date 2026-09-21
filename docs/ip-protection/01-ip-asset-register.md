# Inaya IP Asset Register

**Compiled:** 2026-09-21, directly from this workspace's git history and package manifests. **Preserve, do not overwrite** — update by appending, so the register itself has a history.

## How to read this register

- **Creator** — the git author identity on record for the earliest commits (a real person/account, per the repository's own commit log), not necessarily the legal IP owner. Ownership is what Phase 2's assignment agreements establish.
- **Intended owner** — left as `[INAYA LEGAL ENTITY NAME]` throughout. Every asset below should be owned by the same confirmed entity; do not assign different assets to different entities without a specific reason.
- **Evidence** — what in this repository proves the creation date and authorship (git log, commit hash, release tag).

## 1. Source Code Repositories

| Asset | Repository | First Commit | Latest Commit | Commits | Intended Owner |
|---|---|---|---|---|---|
| Main monorepo — dApp, Business Workspace, AI systems, RAG/retrieval, Security Layer, mobile-shared logic, smart-contract deployment tooling, desktop app wrappers, storage/S3-compat layer | `github.com/Talhawaqas/codespaces-blank` | 2026-07-06 | 2026-09-21 (`7857efa`) | 415 | `[INAYA LEGAL ENTITY NAME]` |
| Inaya Mobile — native/cross-platform mobile app | `github.com/Talhawaqas/inaya-mobile` | 2026-07-29 | 2026-09-21 (`a000f2a`) | 74 | `[INAYA LEGAL ENTITY NAME]` |
| Custody SDK (`@inaya-network/custody-sdk`, npm, v1.0.10-beta) — client-side encryption, binary sharding, key derivation, wallet/custody primitives | `github.com/Talhawaqas/custody-sdk` | 2026-07-30 | 2026-09-08 (`1eab6ee`) | 46 | `[INAYA LEGAL ENTITY NAME]` |

**Note:** custody-sdk is intentionally excluded from the main monorepo's own git tracking (`.gitignore`) because it is developed as its own independent repository, not because it is untracked. Its full history is preserved in its own repo above.

### 1.1 Packages published from the custody-sdk repository's own workspace (`custody-sdk/packages/`)

These are not separate repositories — they are workspace packages inside the same `github.com/Talhawaqas/custody-sdk` repo above, each independently published to npm. Confirmed directly against the live npm registry on 2026-09-21:

| Package | npm name | Published Version | First Commit (within custody-sdk) |
|---|---|---|---|
| React SDK | `@inaya-network/react` | 0.1.0 | 2026-08-01 |
| CLI | `inaya-cli` | 0.1.0 | 2026-08-01 |
| Project scaffolding tool | `create-inaya-dapp` | 0.2.0 | 2026-08-01 |
| Node operator daemon | `@inaya-network/node-daemon` | 0.1.0 | 2026-08-17 |
| Bridge SDK | `@inaya-network/bridge-sdk` | **Not yet published** (confirmed 404 on the npm registry, 2026-09-21) | 2026-08-29 |

The node daemon's own source lives at `custody-sdk/packages/node-daemon`; the announcement script at `inaya-network-dapp/NODE_DAEMON_ANNOUNCEMENT_SCRIPT.md` is a separate, unrelated file (marketing copy, not source).

## 2. Native Applications (within the main monorepo)

| Asset | Path | First Commit Touching Path | Current Version | Purpose |
|---|---|---|---|---|
| Inaya Business Workspace desktop wrapper (Windows/Linux) | `inaya-desktop/` | 2026-08-19 | 0.1.1 (Cargo.toml) | Tauri desktop app: tray, notifications, DirectSync, Inaya Drive mount, native firewall enforcement |
| Inaya dApp desktop wrapper (Windows/Linux) | `inaya-dapp-desktop/` | 2026-08-19 | 0.1.0 (Cargo.toml) | Tauri desktop app for the main Web3 dApp |
| Inaya Drive — shared S3 client/SigV4 signer core | `inaya-drive-core/` | 2026-09-20 | 0.1.0 (Cargo.toml) | Shared Rust crate used by both platform-specific Drive helpers |
| Inaya Drive — Windows helper (WinFSP mount) | `inaya-drive-helper/` | 2026-09-16 | 0.1.0 (Cargo.toml) | Real Windows drive-letter mount; **GPL-3.0-licensed dependency (WinFSP)** — see note below |
| Inaya Drive — Linux helper (FUSE mount) | `inaya-drive-helper-linux/` | 2026-09-20 | 0.1.0 (Cargo.toml) | Real Linux mount point via `fuser` (MIT) |
| Inaya Migration Agent — AWS/Azure/GCS → Inaya migration tool | `inaya-migration-agent/` | 2026-09-20 | 0.1.0 (package.json) | Standalone migration CLI/engine, also linked into the main dApp for the Cloud Backup Scheduler |

**Flag for legal review:** `inaya-drive-helper`'s WinFSP dependency is GPL-3.0-licensed. The architecture already isolates it into its own separate process/binary specifically to keep the rest of the codebase proprietary (documented directly in `inaya-desktop/src-tauri/src/lib.rs`'s own comments) — but this should be confirmed by counsel as sufficient to keep `inaya-desktop` and the rest of the codebase outside GPL's copyleft obligations before any IP assignment or licensing decision treats the whole codebase as uniformly proprietary.

## 3. Smart Contracts / Protocol Software

| Asset | Location | Chain(s) |
|---|---|---|
| `InayaToken.sol`, `InayaStaking.sol`, `InayaNodeRegistry.sol`, `InayaNodeReputation.sol`, `InayaProofRegistry.sol`, `InayaBackupRegistry.sol`, `InayaCorporateEscrow.sol`, `InayaEgressTimelockVault.sol`, `InayaSecurityPolicy.sol`, `InayaThreatRegistry.sol`, `InayaThreatReporter.sol`, `InayaHackathonRewards.sol` | `contracts/` (root of main monorepo) | BSC Testnet (primary), per the project's own roadmap |
| `contracts/bridge/`, `contracts/governance/`, `contracts/oracle/`, `contracts/automation/` | Same repo, subdirectories | BSC Testnet, Ethereum Sepolia, Avalanche Fuji, Arbitrum Sepolia, Hedera Testnet, per roadmap |
| Non-EVM bridge contracts (Move/Anchor) | `aptos/`, `solana/`, `sui/` (root of main monorepo) | Aptos Testnet, Solana (Anchor program), Sui Testnet |

First commits touching these paths: `contracts/` — 2026-08-03; `solana/` — 2026-08-29; `aptos/` and `sui/` — 2026-09-01.

## 4. Documentation, Whitepaper, and Fundraising Materials

| Asset | Location | Notes |
|---|---|---|
| Whitepaper | Served live at `/whitepaper` (`inaya-network-dapp/src/app/page.js`) | Not a standalone file — content lives inside the main dApp's page component |
| Company Profile, Ecosystem Overview, Ecosystem Architecture, Ecosystem Dev Deep-Dive, GTM Strategy (PDFs) | `inaya-network-dapp/public/documents/*.pdf`, generated from `inaya-network-dapp/scripts/fundraising-docs/content/*.js` | Source-controlled; each PDF is regenerated from its own content file, not hand-edited |
| Business Workspace user/setup guides | `inaya-network-dapp/docs/*.md` | Multiple |

## 5. Branding

| Asset | Location |
|---|---|
| Logo | `inaya-network-dapp/public/inaya-logo.png` |
| Favicon | `inaya-network-dapp/public/favicon.ico` |
| Word marks in use | "INAYA", "INAYA NETWORK" |

**Note:** No separate, versioned brand-guideline document (color palette, usage rules, logo variants) was found in the repository. If one exists outside this workspace, add it here; if not, consider creating one — it strengthens both the trademark record and everyday brand consistency.

## 6. AI Systems, Security Layer, and Other Internal Systems (by reference)

These are extensive and change frequently — rather than duplicate an inventory that will immediately go stale, this register points to where the authoritative, current list already lives:

- **AI systems / RAG / retrieval** — `inaya-network-dapp/src/lib/rag/`, `inaya-network-dapp/src/lib/inaya-knowledge.js`, and the various AI assistant route handlers under `inaya-network-dapp/src/app/api/ai/`.
- **Security Layer** — `inaya-network-dapp/src/lib/security*.js` and the `InayaThreatRegistry.sol`/`InayaThreatReporter.sol` contracts listed above.
- **Node software** — `custody-sdk/packages/node-daemon` (see Section 1.1).
- **Full feature-by-feature inventory** — `inaya-network-dapp/scripts/pilot-guides/complete-feature-guide-content.js`, the source for the already-generated `Inaya_Complete_Feature_Guide.pdf`, is the most complete existing catalog of shipped features and their backing files.

## Evidence Preservation

This register itself is version-controlled (git), so every future edit to it is dated and attributed automatically — the same evidence discipline it's recommending for the rest of the project. Do not rewrite history on this file; append dated updates instead.
