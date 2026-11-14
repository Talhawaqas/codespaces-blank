# Node Registry Fix + Node Operator Daemon — Dev Summary

Combined Node Registry SOW: fixed `InayaNodeRegistry.sol`'s security/consistency gaps, secured
settlement authority behind a multisig, automated payouts, shipped a minimal node operator
daemon, and brought the Operator Manifesto's claims back in line with what the contract
actually does.

## Key features added

- **Commission rates corrected in the contract** — `InayaNodeRegistry.sol` now pays 30% / 40%
  / 50% (Entry / Mid / Enterprise), matching the published Operator Manifesto. The contract was
  the one that was wrong (50/60/70); fixed there rather than editing the manifesto to match a
  bug.
- **Settlement timelock** — commission payouts are no longer instant transfers. `queueSettlement`
  / `queueSettlementsBatch` now queue a payout with a 36-hour unlock time; a separate
  `releaseSettlement` / `releaseSettlementsBatch` call actually pays out, and is deliberately
  callable by *anyone* once unlocked (not just the operator) — a real window to catch a
  compromised verifier key before funds move, without breaking the "you never have to claim it"
  promise.
- **`SettlementSkipped` event** — every skip condition in the batch functions (unregistered node,
  zero revenue, insufficient reserve) now emits an event instead of silently `continue`-ing, so a
  backend watching events can detect and retry them.
- **Verifier authority moved to a 2-of-3 multisig** — deployed a real Gnosis Safe
  (`0x27413C3930B228588d0C39d090bae6Ee7030560D`, BSC Testnet, owners: deployer/treasury/former
  verifier EOA) and repointed `verifierWallet` at it via `setVerifierWallet()`. No single key can
  queue or release settlements anymore.
- **Redeployed and verified** — new contract at `0xd12a38e8564d19797B19cF8F80b54DB09B3FD881`.
  Verified via a local Hardhat test with a genuine 36-hour time fast-forward (13/13 checks:
  commission math, queue-doesn't-pay-immediately, pre-unlock revert, post-unlock release,
  double-release protection, all 3 skip reasons) *and* a live BSC Testnet transaction confirming
  the pre-unlock revert on the actual deployed contract.
- **Automated settlement relayer** — new `GET /api/nodes/settlements/release` route, triggered
  daily by Vercel Cron, scans queued settlements and releases everything past its unlock time via
  a dedicated low-privilege relayer wallet (no special on-chain authority — it can only release
  funds a verifier already queued and the timelock already cleared). Gated by `CRON_SECRET`.
- **`@inaya-network/node-daemon`** — new, minimal node operator daemon, **published on npm**:
  ```bash
  npm install -g @inaya-network/node-daemon
  ```
  - `login` — encrypted local keystore (same PBKDF2 + AES-256-GCM pattern as `inaya-cli`), own
    `~/.inaya/node-daemon/config.json` so it can coexist with a separate `cli` session.
  - `register <capacityGB>` — on-chain `registerNode()` + off-chain coordinator registration.
  - `start` — foreground heartbeat loop.
  - `service install` / `uninstall` — wraps `start` as a native background service
    (Windows Service / systemd / launchd via `node-windows`/`node-linux`/`node-mac`).
  - Plain Node.js, no Docker (most operators are on Windows) — registration + wallet custody +
    heartbeat telemetry only, deliberately **no shard storage/serving**.
- **Operator Manifesto migrated to a tracked source** — was a raw exported PDF binary with no
  source in the repo; now generated from `scripts/fundraising-docs/content/operator-manifesto.js`
  through the same HTML→PDF pipeline as the other investor docs. Content fixes:
  - "Download Docker Core" → install the Node Daemon (Docker was ruled out).
  - "receives their USDT instantly" → accurate language about the 36-hour timelock (the
    never-claim-it promise still holds via the automated relayer, it just isn't instant).
  - New "Mainnet Assignment Priority" section with an actual defined threshold: 90+ days at
    95%+ testnet uptime.

## Deployed addresses (BSC Testnet)

| Contract | Address |
|---|---|
| InayaNodeRegistry (new) | `0xd12a38e8564d19797B19cF8F80b54DB09B3FD881` |
| Verifier Safe (2-of-3) | `0x27413C3930B228588d0C39d090bae6Ee7030560D` |

## Verification performed

- Local Hardhat lifecycle test with real time fast-forward (36h + 60s): 13/13 checks passed.
- Live BSC Testnet transaction: queued a real settlement, confirmed immediate release correctly
  reverts with "Settlement still locked".
- Settlement relayer route: confirmed it rejects unauthenticated requests (401) and correctly
  reads on-chain state with the right secret (0 eligible, accurate for the one settlement still
  inside its 36h window).
- Node daemon: full `login` → `register` → `start` cycle run against live BSC Testnet from this
  machine (real on-chain tx + real off-chain API calls + multiple real heartbeats), then a
  separate real `npm install -g @inaya-network/node-daemon` from the public registry confirmed
  with `inaya-node-daemon --version`.

## Still needs you (not code)

- **Vercel environment variables** — `RELAYER_PRIVATE_KEY` and `CRON_SECRET` exist in
  `inaya-network-dapp/.env.local` locally but Vercel deploys don't read that file. Set both in
  the Vercel project's environment variables or the settlement relayer cron won't have a wallet
  to sign with in production.
- **`inaya-node-daemon service install`** — not run anywhere by design (installing an OS service
  is a system-level change). Run it yourself on each machine you want the daemon running
  unattended.
