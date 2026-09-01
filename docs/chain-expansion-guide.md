# Chain Expansion Guide (Interop Layer)

How to bring up the first real Wormhole NTT route for `$INAYA`, and every route after it. This is the process, sourced against the [NTT CLI reference](https://wormhole.com/docs/products/token-transfers/native-token-transfers/reference/cli-commands/) and the [EVM](https://wormhole.com/docs/products/token-transfers/native-token-transfers/guides/deploy-to-evm/) / [SVM](https://wormhole.com/docs/products/token-transfers/native-token-transfers/guides/deploy-to-solana/) deployment guides — **not yet executed**. See `docs/multichain-support-matrix.md` for current status (every chain is Tier C / undeployed as of this writing).

This is a testnet/devnet-only process for this SOW. No mainnet step is in scope.

## Prerequisites

- The NTT CLI (`@wormhole-foundation/ntt` per Wormhole's published tooling).
- A funded deployer wallet on each target testnet — the same `DEPLOYER_PRIVATE_KEY` wallet Inaya's native bridge already uses is the natural choice, keeping key management consistent with `docs/chain-adapters.md`'s worked example.
- `$INAYA`'s existing deployed contract address on each chain that already has one (BSC Testnet's real `$INAYA`; the wrapped versions on Sepolia/Fuji/Arbitrum Sepolia are a separate, unrelated token from Inaya's own bridge — NTT needs its own decision on which contract it manages per chain, see the note below).

## Steps

1. **`ntt init`** — creates a `deployment.json` describing the NTT deployment (mode: hub-and-spoke, per `docs/inaya-interoperability.md`'s chosen model).
2. **`ntt add-chain`** — once per target chain, specifying the token address and transfer mode (locking on the hub / BSC Testnet, minting on every spoke).
3. **`ntt deploy`** (or the chain-specific deploy command) — deploys the `NttManager` + `Transceiver` pair to that chain. This is the real, per-chain destination deployment Phase 4's Tier C classification refers to.
4. **Set minting authority** — the final step: the deployed `NttManager` must be authorized as a minter on every spoke chain's token contract (burn-and-mint chains) — or, for the hub, no minting authority change is needed since the hub only locks.
5. **Verify** — `ntt status` (or equivalent) confirms `deployment.json` matches on-chain state, the same "verify with a real read, not an assumption" discipline `scripts/testnet-health-check.js` already applies to Inaya's native bridge.
6. **Register in Inaya's own registry** — update `src/lib/chain-adapters/interop/capabilityRegistry.js`'s entry for that chain from Tier C/`ROUTE_AVAILABLE` to `TRANSFER_AVAILABLE`, and only to `TRANSFER_TESTED` once a real transfer has actually been sent and confirmed end-to-end — never ahead of proof, matching every other capability upgrade in this codebase (`docs/chain-adapters.md`'s registry discipline).

## Open decision: which `$INAYA` does NTT manage?

Inaya's native bridge already has its own wrapped-`$INAYA` contracts on Sepolia/Fuji/Arbitrum Sepolia (`deployments/bridge/*.json`). NTT deploying a *second*, separate native-mode `$INAYA` representation on the same chains would fragment liquidity and confuse "which `$INAYA` is canonical on Sepolia" — a real risk the SOW's Phase 3 accounting requirements exist to prevent. The two realistic options, to be decided before Phase 3 implementation proceeds past this doc:

- **Route interop-layer chains around Inaya's existing spokes entirely** (Ethereum via Wormhole, not via Inaya's existing Sepolia deployment) — avoids the collision, but means two different `$INAYA` representations could exist on the same underlying network (Ethereum mainnet vs. Ethereum via Wormhole is fine; Sepolia native bridge vs. Sepolia-if-NTT-also-targeted-it is the actual collision to avoid).
- **Retire the native bridge's spoke role in favor of NTT once NTT is live there**, keeping Inaya's native bridge scoped to BSC (home) + wherever NTT doesn't reach — a bigger decision, out of scope to make unilaterally here.

Recommendation: NTT's first real routes should target chains Inaya's native bridge does **not** already cover (Base, Optimism, Polygon, Solana-if-native-bridge-Solana-stays-message-only) rather than re-deploying onto Sepolia/Fuji/Arbitrum Sepolia, sidestepping the collision until a deliberate decision is made either way.
