# Inaya Interoperability Provider Evaluation

Phase 1 deliverable for the Broad Multi-Chain Expansion SOW. Evaluates Wormhole and LayerZero against Inaya's actual existing architecture (`docs/chain-agnostic-audit.md`, `docs/chain-adapters.md`), against current provider documentation (cited below, checked live — not from training-data assumptions), not marketing claims. No contracts are deployed as part of this document.

## Existing Inaya bridge, for reference

Inaya already runs its own hub-and-spoke bridge: BSC Testnet (home) holds the canonical `$INAYA` and staking ledger; Sepolia/Fuji/Arbitrum Sepolia (spokes) hold a wrapped representation minted/burned via `InayaTokenBridgeSpoke`; Solana Devnet mirrors the same message-hash scheme in a native program. Security is M-of-N validator signatures (`InayaValidatorSet.sol`, currently 2-of-3) over a canonical message hash, replay-protected per chain. This is architecturally a **lock-and-mint hub-and-spoke model with Inaya's own validator set as the trust root** — that description matters below, because it's structurally closer to one provider's model than the other's.

## A. Wormhole

### Wrapped Token Transfers (WTT)
Wormhole's original token bridge product. Lock-and-mint: `$INAYA` gets locked/attested on the source chain, and a wrapped representation is minted on each destination chain the first time it's attested there (a real, if standardized, destination-chain deployment step — not zero-deployment). Coverage is Wormhole's broadest: 30+ chains including Ethereum, BSC, Arbitrum, Avalanche, Polygon, Solana, Sui, Aptos, Near, and others spanning EVM, SVM, and Move VM — this is the only one of the evaluated options that plausibly reaches the SOW's long-tail targets (Near, Injective, Sei-class ecosystems). Supports automatic relaying (a Wormhole-run relayer submits the destination transaction, no separate Inaya cron needed for that leg) or manual/self-relay. Security: the Wormhole **Guardian network** — 19 independent guardians, 13/19 multisig — attests to every message; this is an *external* trust root, not Inaya's own validator set. Fees are protocol message fees plus destination gas (paid by the relayer if automatic relay is used).

Sources: [WTT Overview](https://wormhole.com/docs/products/token-transfers/wrapped-token-transfers/overview/), [WTT Transfer Workflow Tutorial](https://wormhole.com/docs/products/token-transfers/wrapped-token-transfers/tutorials/transfer-workflow/), [Portal Bridge](https://portalbridge.com/)

### Native Token Transfers (NTT)
Wormhole's newer framework, purpose-built for a project that already has its own token deployed on one or more chains and wants to extend it without wrapping. Two transfer modes: **hub-and-spoke** (lock on one chain, mint/burn on the others — this is *exactly* Inaya's existing bridge shape) or **burn-and-mint** everywhere. Architecture is `NttManager` (per-chain, owns rate-limiting and message construction) + `Transceiver` (handles the actual cross-chain messaging — pluggable, defaults to Wormhole's Guardian network but the interface allows others). Built-in configurable per-chain rate limiting with a queue-and-release mechanism for transfers that exceed it. Chain coverage is narrower than WTT: EVM chains, Solana, Aptos, Sui — it does not currently reach Near/Injective/Sei-class chains. Testnet: Solana deployment must target Devnet specifically (NTT does not support Solana's separate "Testnet" cluster for token creation). Still uses the Guardian network underneath for message attestation by default, so the external-trust-root property is the same as WTT.

Sources: [NTT Overview](https://wormhole.com/docs/products/token-transfers/native-token-transfers/overview/), [NTT Architecture](https://wormhole.com/docs/products/token-transfers/native-token-transfers/concepts/architecture/), [NTT Rate Limiting](https://wormhole.com/docs/products/token-transfers/native-token-transfers/configuration/rate-limiting/), [NTT FAQs](https://wormhole.com/docs/products/token-transfers/native-token-transfers/faqs/), [Deep dive: NTT](https://wormhole.com/blog/deep-dive-wormhole-native-token-transfers-ntt), [NTT SVM Deployment](https://wormhole.com/docs/products/token-transfers/native-token-transfers/guides/deploy-to-solana/)

## B. LayerZero

### OFT (Omnichain Fungible Token)
Burn-and-mint standard: a token is burned on the source chain's OFT contract and minted on the destination's — no wrapped-IOU model, one logical token across every chain it's deployed on. Requires deploying an OFT (or an "OFT Adapter" wrapping an existing token, for the chain that already has the canonical token) on every destination chain — this is real, per-chain Inaya-side deployment work, not automatic. Coverage is the widest claimed of any option evaluated: LayerZero cites 170+ chains and 733+ production OFTs as of 2026, with confirmed native Solana support (a real Solana program, not an EVM-only claim) and a 2026 Cardano integration. Security is the standout architectural difference: LayerZero V2 uses **Decentralized Verifier Networks (DVNs)** — a pluggable, per-application security stack where the app (Inaya) chooses which DVNs must attest to a message, with a configurable required/optional-threshold model. This means **Inaya's own existing validator set could, in principle, run as one of the required DVNs**, keeping Inaya's own trust root in the loop rather than fully outsourcing security to a third party — something neither Wormhole product offers, since Wormhole's Guardian network is fixed and external. The tradeoff: running a DVN is real off-chain infrastructure Inaya would have to operate (a new service, not just a cron route), and per-message fees scale with how many DVNs are required (a 5-DVN stack costs roughly 5x a 1-DVN stack per message).

Sources: [LayerZero V2 Docs](https://docs.layerzero.network/v2), [DVN Overview](https://docs.layerzero.network/v2/workers/off-chain/dvn-overview), [LayerZero V2 DVN Security Model](https://cryptocj.org/posts/layerzero-v2-dvn-security/), [LayerZero is Live on Solana](https://medium.com/layerzero-ecosystem/layerzero-is-live-on-solana-b58cfdc55ad5), [LayerZero V2 Solana OFT](https://docs.layerzero.network/v2/developers/solana/oft/account), [The Default Is Many Chains](https://layerzero.network/blog/the-default-is-many-chains)

## Comparison

| Requirement | Wormhole WTT | Wormhole NTT | LayerZero OFT |
|---|---|---|---|
| Chain coverage | Broadest — 30+ chains | Narrower — EVM, Solana, Aptos, Sui | Widest claimed — 170+ chains, 733+ production OFTs |
| EVM | Yes | Yes | Yes |
| Solana | Yes (wrapped) | Yes (native, Devnet-only for testnet token creation) | Yes (native Solana program) |
| Sui | Yes | Yes | Not confirmed in current docs |
| Aptos | Yes | Yes | Not confirmed in current docs |
| Other ecosystems (Near, Injective, Sei-class) | Yes — the only option here that reaches these | No | No |
| Testnet support | Yes | Yes (Solana: Devnet only, not "Testnet" cluster) | Yes |
| Token transfers | Wrapped (lock-and-mint per chain) | Native (hub-and-spoke or burn-and-mint, no wrapping) | Native (burn-and-mint, no wrapping) |
| Messaging | Attestation-based (VAA) | Built on the same Wormhole messaging, pluggable Transceiver | Generalized arbitrary-message passing (OFT is one app built on it) |
| Destination deployment requirement | Wrapped token auto-deployed on first attestation to a new chain (not zero-deployment) | `NttManager` + `Transceiver` deployed per chain | OFT (or OFT Adapter) deployed per chain — most explicit per-chain deployment step of the three |
| Wrapped token model | Yes — this IS the model | No | No |
| Native token model | No | Yes | Yes |
| Relaying | Automatic relay available, or self-relay | Manual/self-relay (rate-limited, queued) | Executor role (LayerZero-run or self-run) delivers the message |
| Fees | Protocol message fee + destination gas | Protocol message fee + destination gas | Per-DVN message fee (scales with DVN count) + Executor fee |
| Security | Guardian network (19 guardians, 13/19 multisig) — external, fixed | Same Guardian network by default (Transceiver is pluggable in principle) | DVN stack — **pluggable; Inaya could run its own validator set as a required DVN** |
| Control of token contracts | Wrapped contracts are provider-standard (Portal-style), not Inaya-authored | Inaya deploys/controls `NttManager` around its own existing token contract | Inaya deploys/controls the OFT contract itself |
| Developer complexity | Lowest — standard, well-trodden Portal-bridge flow | Moderate — new-ish framework (2024+), fewer integrators than WTT | Moderate-high — DVN configuration, Executor setup, per-chain OFT deploys |
| Inaya suitability | Best for broad long-tail reach (Near/Injective/Sei-class) where wrapped semantics are acceptable | Best structural match to Inaya's existing hub-and-spoke architecture and 1:1 native-accounting requirement | Best if Inaya wants to eventually put its own validator set in the security path; adds real new off-chain infrastructure to run one |

## Recommendation

**Primary provider: Wormhole, using NTT as the default transfer mode, with WTT available as a documented fallback for chains NTT doesn't reach.**

Reasoning:

1. **NTT is the closest structural match to what Inaya already built.** Inaya's existing bridge is already a hand-rolled hub-and-spoke lock-and-mint system with per-chain rate-limiting via replay protection. NTT's hub-and-spoke mode is the same shape, with the same 1:1 native-accounting, source-chain-backing, and no-unauthorized-supply-creation guarantees the SOW's Phase 3 requires — without introducing a wrapped-token model that would fragment `$INAYA`'s provenance across a new set of per-chain wrapped contracts.
2. **Lowest incremental operational overhead.** Neither WTT nor NTT requires Inaya to stand up new off-chain infrastructure — both use the existing Wormhole Guardian network as-is. LayerZero's DVN model is architecturally more aligned with "preserve Inaya's own validator/security architecture" (Phase 9), but realizing that benefit means running Inaya's validator set as live DVN node software — a real new service, not a config change. That's a legitimate future enhancement, not a Phase-1 requirement, and doing it now would be scope creep beyond what "minimum Inaya-side deployment overhead" (the SOW's own stated objective) calls for.
3. **WTT fills the long-tail gap.** Neither NTT nor LayerZero currently reaches Near/Injective/Sei-class chains. WTT does, and since it's the same vendor and SDK family as NTT, using it as a documented fallback for those specific chains doesn't add a second full vendor integration (and a second security model to document) the way adding LayerZero as a second primary provider would.
4. **LayerZero is not rejected — it's deferred, with a reason.** Its DVN model is the more interesting long-term security story for Inaya specifically. The Phase 2 provider-neutral abstraction is designed so LayerZero (or any other provider) can be added later as a second `InteropProviderAdapter` without touching Inaya's core business logic — this evaluation doesn't foreclose that, it just doesn't select it as the first one to ship.

This selection is made on the technical evidence above, not on chain-count marketing claims — LayerZero's raw "170+ chains" figure is real but doesn't reach several of the SOW's named priority ecosystems in its confirmed docs, and Wormhole's 30+-chain WTT figure is the one actually verified against Near/Injective/Sei-class coverage.
