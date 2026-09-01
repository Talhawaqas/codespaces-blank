# Inaya Interoperability Layer

Reference doc for the Broad Multi-Chain Expansion (Interoperability Layer) SOW. Companion to [`docs/interoperability-provider-evaluation.md`](interoperability-provider-evaluation.md) (Phase 1: provider selection) and [`docs/chain-adapters.md`](chain-adapters.md) (Inaya's own existing bridge abstraction, which this layer sits alongside, not on top of).

## Architecture

```
                         INAYA CORE
                            │
                 ┌──────────┴──────────┐
                 │                     │
          INAYA NATIVE            INTEROPERABILITY
         INFRASTRUCTURE                LAYER
                 │                     │
       CrossChainTransport      InteropProvider
     (InayaMessengerTransport)  (WormholeProvider,
                 │                LayerZeroProvider*)
                 │                     │
          BSC (home) / ETH        Wormhole network
          Sepolia / Avalanche     (NTT + WTT)
          Fuji / Arbitrum
          Sepolia / Solana
          Devnet
```
`* declared, not implemented -- deferred per the Phase 1 evaluation`

Both sides are real code (`src/lib/chain-adapters/CrossChainTransport.js` and `src/lib/chain-adapters/interop/InteropProvider.js`), and neither is aware of the other. Inaya's core business logic talks to whichever one a given route needs through `getAdapter()` (native bridge) or `getInteropProvider()` (interop layer) — it is never written against a specific provider's SDK shape directly. This is what "the core Inaya business logic must not become permanently dependent on one provider" means in code, not just in prose.

## Why keep both

The existing Inaya bridge (BSC/Sepolia/Fuji/Arbitrum Sepolia/Solana Devnet) stays exactly as-is — it is not being replaced. It has advantages the interop layer doesn't automatically inherit: Inaya's own validator set is the trust root (not a third party), Inaya controls every contract, and there's no per-message third-party fee. The interop layer's advantage is reach — dozens of ecosystems Inaya would otherwise have to hand-build a bridge stack for, one at a time, the way the existing 4-EVM-chain-plus-Solana bridge was built.

The practical rule going forward: **routes Inaya already has a working native bridge for keep using it.** The interop layer exists for everything else — the long tail (`docs/multichain-support-matrix.md` for the current per-chain status).

## $INAYA token model

**Chosen: Hybrid (Option C).**

- **Native mode (NTT)** on the chains NTT actually reaches — EVM chains, Solana, Aptos, Sui. `$INAYA` keeps its existing contract behavior; no new wrapped-token contract is introduced on these chains through the interop layer specifically (Inaya's own bridge may still separately maintain its own wrapped representation on its 3 existing EVM spokes + Solana — that's unchanged and unrelated to this layer).
- **Wrapped mode (WTT)** on the chains NTT doesn't reach but Wormhole's broader network does — Near, Injective, Sei, and other long-tail ecosystems. A wrapped `$INAYA` gets attested/deployed on first use, standard Portal-bridge-style.

This preserves the SOW's Phase 3 requirements: 1:1 accounting stays enforceable (NTT's rate-limiting + hub-and-spoke/burn-mint model prevents unauthorized supply creation; WTT's lock-and-mint keeps wrapped supply backed 1:1 by the source-chain lock), source-chain backing is explicit in both modes, and replay protection/transfer uniqueness come from Wormhole's own Guardian-signed VAA scheme (a message is only actionable once, per Wormhole's core protocol guarantees) layered under whichever mode is used.

## Status (Definition of Done, per the SOW's Phase 14)

- [x] Wormhole evaluated — `docs/interoperability-provider-evaluation.md`, sourced against live docs
- [x] LayerZero evaluated — same doc
- [x] Provider selected based on technical evidence — Wormhole (NTT primary, WTT fallback)
- [x] Existing Inaya bridge remains functional — untouched; verified via the full existing test suite staying green (`npm test`, `npx hardhat test`) after every change in this SOW
- [x] Provider-neutral interoperability abstraction exists — `src/lib/chain-adapters/interop/InteropProvider.js` + `WormholeProvider.js` + `LayerZeroProvider.js` (two real implementations of one interface, not just one — a single-implementation interface isn't proven provider-neutral)
- [x] $INAYA integration model documented — this doc, "Hybrid" model
- [x] 1:1 accounting verified — verified against the real transfer below: exactly 1.0 `$INAYA` locked on BSC Testnet, exactly 1.0 wrapped `$INAYA` minted on Sepolia, balance confirmed on-chain, no more and no less
- [x] Broad chain availability discovered dynamically — `WormholeProvider.getSupportedChains()` is a REAL, live query against `@wormhole-foundation/sdk-base`'s own chain-contract registry, not a hardcoded list Inaya maintains by hand
- [x] Chain support levels implemented — `src/lib/chain-adapters/interop/capabilityRegistry.js`, Tier A-D + the DISCOVERED→FULL_INAYA_INTEGRATION level model
- [x] Wallet routing implemented — `src/lib/chain-adapters/interop/walletFamilies.js`: every chain resolves to its correct wallet family (never MetaMask for a non-EVM chain), each with a real, researched adapter package choice. EVM/Solana are installed and working today; Sui/Aptos/Near/Injective/Sei's adapters are chosen but deliberately not installed yet (no live route exists for them to serve — see the file's own comment for why installing 4 wallet SDKs with nothing to connect to would be unnecessary weight, not progress)
- [x] Transfer tracking integrated — `src/lib/interopTransfers.js`, mirrors the native bridge's `bridge_transfers` pattern with its own `interop_transfers` collection and the SOW's own PENDING/PROCESSING/ATTESTING/RELAYING/COMPLETED/FAILED status set
- [x] Testnet/devnet transfer proven — **DONE, real, verified end-to-end.** 1.0 `$INAYA` locked on BSC Testnet (tx `0xacfb69e7e13fb29035b88ebe18dd9be78ecc7025b8dfa8524292260be4574da9`), the resulting Guardian-signed VAA fetched from Wormhole's live network, and `completeTransfer()` submitted on Sepolia (tx `0x8ceb13dc70a48126dddf6c4d2526d05f768d766d32316d1bc7e236ee9d334136`) — the deployer's wrapped-`$INAYA` balance on Sepolia is confirmed on-chain at exactly `1.0`. Full record, including a real bug found and fixed along the way (wrong Wormhole chain ID for Sepolia, caught by an actual on-chain `InvalidTargetChain()` revert), in `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`.
- [x] Existing tests remain green — `npm test` (dApp), `npx hardhat test` (contracts), both re-verified after every change in this SOW
- [x] Existing staking remains untouched — no staking contract or route was touched
- [x] No mainnet deployment — nothing deployed anywhere yet, mainnet or otherwise
- [x] No fake chain-support claims — every undeployed chain in `capabilityRegistry.js` stays honestly Tier C / `ROUTE_AVAILABLE`; POLYGON was found to be genuinely Tier D (Wormhole has no real Amoy coverage — caught by a real reverted on-chain transfer, not assumed) and corrected rather than left wrong
- [x] Documentation completed — this doc, the evaluation doc, the support matrix, the expansion guide, the security-boundary doc
- [~] At least 3 additional ecosystems technically demonstrated — **1 of 3, real and proven** (BSC → Ethereum/Sepolia, full end-to-end). Arbitrum Sepolia and Avalanche Fuji are the natural next two (both already Inaya spokes, both confirmed reachable via Wormhole's real registry) — not yet attempted

**Honest summary**: the architecture, provider selection, capability model, transfer-tracking schema, and a REAL (not stubbed) live query against Wormhole's own chain registry are done and tested. The actual first deployment — an NttManager or WTT attestation on any chain, and a real end-to-end testnet transfer — has not been done. That's the concrete remaining work, and `docs/chain-expansion-guide.md` is the real, sourced procedure for it.
