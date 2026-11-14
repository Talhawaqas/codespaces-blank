# Inaya Interoperability Layer (Wormhole) — Dev Summary

Internal team doc. Not committed to git (matches how we've handled other internal-only summaries).

## What it is

A provider-neutral interoperability layer sitting *alongside* Inaya's existing hand-rolled bridge (BSC/Sepolia/Fuji/Arbitrum Sepolia/Solana), not replacing it, per `INAYA_UNIVERSAL_MULTI_CHAIN...` → the Broad Multi-Chain Expansion SOW. Goal: reach many more chains through an established interoperability protocol instead of Inaya hand-building a custom bridge stack per chain.

## Provider decision

Evaluated Wormhole and LayerZero against live docs, not marketing (`docs/interoperability-provider-evaluation.md`). **Selected Wormhole** — NTT (native, no wrapping) as the intended primary mode long-term, WTT (wrapped, lock-and-mint) as what's actually implemented right now, since NTT requires its own CLI/Foundry/Anchor deployment toolchain that wasn't set up this pass. LayerZero evaluated and deliberately deferred (its DVN model would let Inaya's own validator set participate in message security, which is compelling — but requires running new off-chain infra, out of scope for now).

## Architecture

`src/lib/chain-adapters/interop/` — `InteropProvider` (abstract interface), `WormholeProvider` (real implementation), `LayerZeroProvider` (declared, unimplemented — the interface has two implementations so it's actually proven provider-neutral, not just structured that way on paper). Separate capability registry (`capabilityRegistry.js`, Tier A–D + its own support-level vocabulary) from the native bridge's `registry.js` — a chain's status on one system says nothing about the other.

## The real thing: a full end-to-end transfer, verified on-chain

Not a demo, not a dry run — genuinely locked and received:

- **Attestation** (registers `$INAYA` on Wormhole's network): BSC Testnet tx [`0x09f6fabe...`](https://testnet.bscscan.com/tx/0x09f6fabe0f111ce035a31c3262ffe0300d0cdf72a4b7f54811ed76a8b7cd7fb4)
- **Wrapped token created** on Sepolia: [`0xAC711C4aC50E4280c790D64fE816e217203b7ab1`](https://sepolia.etherscan.io/address/0xAC711C4aC50E4280c790D64fE816e217203b7ab1) — real ERC20, `name="Project Inaya"`, `symbol="INAYA"`, `decimals=18`
- **1.0 `$INAYA` locked** on BSC: tx [`0xacfb69e7...`](https://testnet.bscscan.com/tx/0xacfb69e7e13fb29035b88ebe18dd9be78ecc7025b8dfa8524292260be4574da9)
- **Completed on Sepolia**: tx [`0x8ceb13dc...`](https://sepolia.etherscan.io/tx/0x8ceb13dc70a48126dddf6c4d2526d05f768d766d32316d1bc7e236ee9d334136) — destination wallet balance verified at exactly `1.0`

Full record: `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`.

## Real bugs found and fixed (not just claimed done)

1. **Wrong Wormhole chain ID for Sepolia.** Wormhole registers Sepolia as its own distinct chain (ID `10002`), separate from mainnet Ethereum (ID `2`) — unlike BSC/Avalanche, which have a single mainnet-name-covers-testnet mapping. First transfer attempt used `2`, reverted on-chain with `InvalidTargetChain()` (selector `0x376f6e4a`, confirmed by computing keccak256 selectors for every custom error in Wormhole's actual `Bridge.sol` source and matching byte-for-byte — not guessed). Same latent bug existed in `WormholeProvider.getSupportedChains()` for Ethereum/Arbitrum/Base/Optimism; fixed there too.
2. **Wormhole has no real Polygon Amoy coverage.** Only an unrelated "PolygonSepolia" testnet exists in their registry. `POLYGON` is now honestly Tier D / `DISCOVERED` in the capability registry instead of falsely claiming reach.
3. **The Wormhole SDK's own `submitAttestation()`/transfer wrapper reverted** on both Fuji and (initially) Sepolia. Root-caused by static-calling the underlying `createWrapped(bytes)` directly via ethers with the same VAA the SDK fetched — that succeeded, proving the VAA and destination contract were fine and the SDK's transaction-construction wrapper was the actual problem. Worked around by calling the contract methods directly.
4. **`@wormhole-foundation/sdk` broke the Next.js build entirely.** That package eagerly imports XRPL support regardless of which platform is actually used, and XRPL's dependency chain ships ESM-only files webpack can't bundle. `serverExternalPackages` didn't help (webpack still traced the dynamic import at build time). Fixed by fetching the VAA via a plain REST call to Wormholescan's public API (`api.testnet.wormholescan.io/api/v1/operations?txHash=...`) instead — zero SDK dependency in the relay route.

## `/bridge` UI

Added a "Wormhole Interop Layer" section, separate from the existing native-bridge form. Offers **only** the one proven route (BSC → Sepolia) as an actual send button — every other Wormhole-reachable chain is shown as reference-only info (via the real, live `/api/interop/supported-chains` query), never an offered transfer. Same gas-sponsorship split as the native bridge: user signs the source-chain lock, Inaya's relayer (`RELAYER_PRIVATE_KEY`, same key already used elsewhere) completes the destination mint via a new cron.

## New backend pieces

- `src/lib/interopTransfers.js` — new `interop_transfers` Mongo collection (deliberately separate from the native bridge's `bridge_transfers`), `PENDING/PROCESSING/ATTESTING/RELAYING/COMPLETED/FAILED` status set.
- `POST /api/interop/wtt/initiate`, `GET /api/interop/wtt/relay` (cron, `*/5 * * * *` in `vercel.json`, `CRON_SECRET`-gated, confirmed returning 401 without it in production), `GET /api/interop/wtt/status/[transferId]`.

## Also fixed this pass: White theme readability bug

Unrelated to the interop work but caught mid-session — `text-slate-200`/`text-slate-300` (light grays meant for the dark theme) were hardcoded on primary content across the Business Workspace (dashboard item names, chat bubbles, filenames) instead of the theme-aware token, so they washed out to near-illegible on the White theme. Fixed across `business/page.js` and all 9 view components. Live in production.

## Verification

`test/interop.test.mjs` (18 tests) + `test/interop-transfers.test.mjs` (4 tests, real MongoDB) all passing. Full dApp suite and Hardhat contract suite re-verified green after every change (no regressions to the existing native bridge, staking, or anything else). Production builds confirmed clean after each fix. Live site checked directly — `/bridge` serves the new section, the relay cron route is deployed and its auth gate works.

## Known gaps / explicitly deferred

- **NTT not deployed** — requires Wormhole's own CLI + Foundry/Anchor toolchain, a separate, larger undertaking than what fit this pass. WTT (what's live) is the fallback mode from the evaluation, not the originally-intended primary.
- **Only one route proven** (BSC → Sepolia). Arbitrum Sepolia and Avalanche Fuji are the natural next two — both already Inaya spokes, both confirmed reachable via Wormhole's real registry, neither attempted yet.
- **Non-EVM wallet UI not built** — Sui/Aptos/Near/Injective/Sei adapters are researched and chosen (`walletFamilies.js`) but not installed; no live route exists yet for them to serve.
- **No mainnet deployment anywhere** — testnet/devnet only, per the SOW's explicit instruction.

## Where things live

- Provider evaluation + architecture docs: `docs/interoperability-provider-evaluation.md`, `docs/inaya-interoperability.md`, `docs/multichain-support-matrix.md`, `docs/chain-expansion-guide.md`, `docs/interop-security-boundary.md`
- Abstraction layer: `inaya-network-dapp/src/lib/chain-adapters/interop/`
- Transfer tracking: `inaya-network-dapp/src/lib/interopTransfers.js`
- API routes: `inaya-network-dapp/src/app/api/interop/`
- Frontend: `inaya-network-dapp/src/app/bridge/page.js` ("Wormhole Interop Layer" section)
- Real transaction record: `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`
- One-off scripts used to prove the transfer: `inaya-network-dapp/scripts/interop-attest-inaya.mjs`, `interop-complete-wrapped-creation.mjs`
- Cron: `inaya-network-dapp/vercel.json` (`/api/interop/wtt/relay`, every 5 min)
