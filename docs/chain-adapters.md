# Inaya Chain Adapters

Reference for `inaya-network-dapp/src/lib/chain-adapters/`, the abstraction layer that sits between Inaya's business logic and the specific chains it talks to. Written after Phase 5 shipped a real new chain through it — every example below is a live address, not a hypothetical.

See [`docs/chain-agnostic-audit.md`](chain-agnostic-audit.md) for the pre-implementation audit this design is based on, and `contracts/bridge/CHAIN_ADAPTER_INTERFACE.md` for the on-chain (Solidity/Rust) side of the same pattern.

## Architecture

```
        Business logic (api/bridge/*, /bridge page, mobile BridgeScreen)
                              |
                     getAdapter(chainId)
                              |
                       ChainAdapter  <-- interface (ChainAdapter.js)
                        /          \
                EVMAdapter      SolanaAdapter        (MOVE/OTHER: interface only, unimplemented)
                    |                 |
              ethers.js          @solana/web3.js
                    |                 |
        BSC / Sepolia / Fuji /   Solana Devnet
        Arbitrum Sepolia
```

A `CrossChainTransport` interface (`CrossChainTransport.js`) sits alongside this for the messaging layer itself — today it has exactly one implementation, `InayaMessengerTransport`, wrapping the existing `InayaMessenger` contracts and the cron relayer. No external transport (LayerZero, Wormhole) is integrated; the interface exists so one could be, without touching adapter code.

## Design principle

Every adapter method wraps a call path that already existed and already worked before the adapter did. The abstraction was built additively — Phase 2 shipped with zero behavior change to any live route, verified by the full test suite staying green. `getFinalityStatus()` is the one genuinely new capability (no chain-specific finality check existed anywhere in this codebase before this work).

## The `ChainAdapter` interface

```js
import { getAdapter } from "@/lib/chain-adapters";

const adapter = getAdapter(chainId); // or getAdapter(chainId, { useServerRpc: true }) server-side

adapter.getChainInfo();                    // the chains.js entry, unchanged
await adapter.getNativeBalance(address);   // bigint, smallest unit
adapter.validateAddress(address);          // boolean
await adapter.getFinalityStatus(txHash);   // { finalized, confirmations, required }
adapter.getExplorerUrl(txHash);            // block explorer link
await adapter.healthCheck();               // { healthy, blockHeight, latencyMs, error }
```

`estimateTransfer`, `initiateTransfer`, and `getTransferStatus` are declared on the interface but still throw `Not implemented` — those wrap the transfer-initiation call sites, which haven't been migrated onto the adapter yet (tracked as follow-up work, not part of this phase's scope). `initiateTransfer`/`getTransferStatus`/`estimateTransfer` throwing a clear error rather than a silent no-op is itself covered by a test (`test/chain-adapters.test.mjs`).

`EVMAdapter` and `SolanaAdapter` are the two real implementations. `CHAIN_FAMILIES.MOVE` / `.OTHER` exist as interface constants only — no Move-based or other chain has a real implementation, and none is claimed to.

## The capability-level registry

`registry.js` layers a graduated support level on top of `chains.js` (which it does not modify):

| Level | Meaning |
|---|---|
| 0 — Discovered | In the registry, no integration |
| 1 — Read-only | Chain info/balances queryable |
| 2 — Wallet | Wallet connectivity works |
| 3 — Message | Cross-chain messaging registries wired |
| 4 — Token transfer | `$INAYA` transfer proven live |
| 5 — Staking | Unified staking interaction proven live |
| 6 — Full ecosystem | Business/app functionality integrated |

Every level is backfilled from what's actually been verified — a chain is never claimed higher than what's been proven. As of this writing:

| Chain | Level | Evidence |
|---|---|---|
| BSC Testnet (home) | Staking | Canonical `$INAYA` + staking ledger, live since SOW-1 |
| Ethereum Sepolia | Staking | Full round-trip bridge + stake proven (`test/CrossChainIntegration.test.js`) |
| Avalanche Fuji | Staking | Same |
| Arbitrum Sepolia | Message | Deployed + registries wired (this phase) — no transfer/stake proven through it yet |
| Solana Devnet | Message | Program deployed **and** wired on-chain (confirmed by a live `bridgeConfig` read — see the audit doc's correction) — no end-to-end message proven yet |
| Polygon Amoy | Discovered | Config only, never deployed (funding-blocked) |

`isTransferReady(chainId)` is `true` only at `TOKEN_TRANSFER` or above — the single place a UI should check before ever saying "you can bridge here."

## How Arbitrum Sepolia was added (worked example)

This is the actual sequence Phase 5 followed — reuse it for the next EVM chain.

1. **Fund the deployer wallet** on the target chain with testnet gas. (`0x4BA0a7c39154e7B7fA72288D29D7fdaf0248b1F2` already had 0.02 Arbitrum Sepolia ETH from an earlier bridge, so no new faucet step was needed.)
2. **Add the network to `hardhat.config.js`** — RPC URL, chain ID, same `DEPLOYER_PRIVATE_KEY` every other spoke uses.
3. **Add the chain ID to `contracts/bridge/ChainIds.sol`** (documentation/off-chain-tooling constant, not enforced on-chain) and to `CHAIN_IDS` in `inaya-network-dapp/src/lib/chains.js`, following the exact field shape every other spoke entry uses (`rpcUrl`, `serverRpcUrl`, `blockExplorerUrl`, `contracts.{wrappedInaya,bridge,stakingGateway,chainRegistry,messenger}` sourced from `NEXT_PUBLIC_*` env vars).
4. **Deploy**: `npx hardhat run scripts/deploy-bridge.js --network arbitrumSepolia`. This is the same script every existing spoke used — no new deployment logic was written. It writes `deployments/bridge/arbitrumSepolia.json`.
5. **Wire the registries** both directions: `npx hardhat run scripts/wire-bridge-registries.js --network arbitrumSepolia` (new spoke learns to trust home + existing spokes), then `--network bscTestnet` (home learns to trust and route to the new spoke).
6. **Verify with real bytecode reads, not assumptions**: `node scripts/testnet-health-check.js` — confirms every deployed address actually has contract bytecode on that chain's RPC.
7. **Add the adapter's capability entry** in `registry.js` at the honest level (`MESSAGE`, not `TOKEN_TRANSFER` — the registries trust each other, but no transfer has been sent and confirmed through them yet).
8. **Add regression tests** to `test/chain-adapters.test.mjs` confirming the new chain resolves through `getAdapter()` and its bridge contract has real bytecode.

A real bug surfaced during step 5: `wire-bridge-registries.js` reads every file in `deployments/bridge/`, including `solanaDevnet.json` — which has no EVM-shaped `.bridge` address, since Solana isn't wired that way. The script crashed on it. Fixed by filtering to `.bridge`-bearing (EVM) deployment files before wiring; Solana's own trust wiring happens on-chain via `solana/wire-devnet.mjs`, which is unrelated. This is now safe for the *next* EVM chain added, too.

## How to add a non-EVM chain

No non-EVM chain beyond Solana has been added, so there's no worked example yet. The shape that would be needed, based on `SolanaAdapter.js`:

1. Confirm the chain has a real client library available (`@solana/web3.js`-equivalent) — don't fake EVM-style calls against a non-EVM chain.
2. Implement a concrete adapter class extending `ChainAdapter`, with `getFinalityStatus()` reporting that chain's *actual* finality model (Solana's is commitment-level, not a confirmation count — see `SolanaAdapter.js`'s comment on why those aren't unified into one shape).
3. Add the family to `CHAIN_FAMILIES` if it's genuinely new (`MOVE`/`OTHER` already exist as placeholders for this).
4. Register the chain's real, deployed capability level in `registry.js` — never higher than proven.

## Security requirements every adapter must preserve

- **No adapter reimplements replay protection, signature verification, or the message hash scheme.** Those live once, in the contracts (`InayaMessenger.sol` / `message.rs`), and the adapter only reads/calls them.
- **`getFinalityStatus()` is additive and logged-only** where it's wired in (`api/bridge/cron/index-events`) — not yet a hard gate on transfer completion. A wrong finality threshold for a given chain must not silently stall real transfers; flipping to a hard gate is a deliberate follow-up decision after watching the logs.
- **Capability levels are never claimed ahead of proof.** `isTransferReady()` existing as a checkable function (rather than a doc-only rule) is what makes "no fake deployments" enforceable in code, not just in review.
- **Every EVM provider uses `staticNetwork: true` with the known chain ID.** Without it, an unreachable or misconfigured RPC makes `ethers.JsonRpcProvider` retry network detection forever in the background — a bug that was hit and fixed during this work (see `EVMAdapter.js`'s comment).

## Testing requirements

- `test/chain-adapters.test.mjs` — registry/factory unit tests (no network calls), adapter boundary tests (unimplemented methods reject clearly), and live regression tests against real RPCs for every chain's `healthCheck()`/bytecode presence.
- Replay protection, message-hash construction, and threshold-signature logic are tested once, against the real contracts, in `test/InayaMessenger.test.js`, `test/CrossChainIntegration.test.js`, and `test/InayaValidatorSet.test.js` — not duplicated at the adapter layer, since the adapter doesn't reimplement that logic.
- `test/ChainIdsSync.test.js` (and `custody-sdk/packages/bridge-sdk/test/chains-sync.test.mjs`) catch chain-ID drift across `chains.js` / `ChainIds.sol` / `constants.rs` for the canonical chain set.
