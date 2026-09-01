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

## Status

Phase 2 (this abstraction) and Phase 4/12 (the capability registry) are real, tested code. **No interop deployment exists yet on any chain** — `WormholeProvider`'s methods are correctly-shaped stubs, not live integrations. See `docs/multichain-support-matrix.md` for the honest per-chain state and `docs/chain-expansion-guide.md` for what deploying the first real route actually requires.
