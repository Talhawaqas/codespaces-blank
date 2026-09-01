# Inaya Multi-Chain Support Matrix

Single source of truth for what "supported" actually means per chain, per the Interop SOW's Phase 12 rule: never say "Inaya supports N chains" without defining the word. Two separate tracks are shown — Inaya's own native bridge (`docs/chain-adapters.md`) and the Wormhole interop layer (`docs/inaya-interoperability.md`) — because a chain's status on one says nothing about the other.

## Inaya's own native bridge

| Chain | Provider available | Wallet | $INAYA transfer | Tested | Staking |
|---|---|---|---|---|---|
| BSC Testnet (home) | — (native) | Yes | Yes | Yes | Yes |
| Ethereum Sepolia | — (native) | Yes | Yes | Yes | Yes |
| Avalanche Fuji | — (native) | Yes | Yes | Yes | Yes |
| Arbitrum Sepolia | — (native) | Yes | Registries wired, transfer not yet sent | No | No |
| Solana Devnet | — (native) | Yes | Program wired on-chain, transfer not yet sent | No | No |
| Polygon Amoy | — (native) | No | No | No | No |

(Source: `src/lib/chain-adapters/registry.js`, verified against live on-chain reads — see `docs/chain-agnostic-audit.md` and `docs/chain-adapters.md`.)

## Interop layer (Wormhole)

| Chain | Provider available | Wallet | $INAYA transfer | Tested | Staking |
|---|---|---|---|---|---|
| BSC (source) | Yes | Existing EVM path | **Yes — real, verified** | **Yes** | No |
| Ethereum (Sepolia) | Yes | Existing MetaMask/EVM path | **Yes — real, verified** | **Yes** | No |
| Arbitrum (Sepolia) | Yes | Existing EVM path | **Yes — real, verified** | **Yes** | No |
| Avalanche (Fuji) | Yes | Existing EVM path | **Yes — real, verified** | **Yes** | No |
| Solana (Devnet) | Yes | Existing Phantom/Solflare path | Wrapped token created and verified; transfer blocked — **BSC was never registered as a trusted source chain on Wormhole's own Solana Devnet Token Bridge** (a guardian-governance action; not something Inaya or any integrator can do) | No | No |
| Sui | Yes | Not yet built (Sui-native wallet needed) | Blocked — Move-level package-version abort inside the Wormhole SDK itself (`@wormhole-foundation/sdk-sui-tokenbridge`, last released 2026-07-29, predates a Sui network upgrade) | No | No |
| Aptos | Yes | Not yet built (Aptos-native wallet needed) | Blocked — explicit VM error: `publishing module bytecode version 5 is not allowed; minimum is 6`. The Wormhole SDK ships bytecode compiled for an older Aptos VM version (same SDK-staleness pattern as Sui) | No | No |
| Polygon | **No — Wormhole has no real Amoy coverage** | Existing EVM path | No | No | No |
| Base | Yes | Existing EVM path | No — not attempted yet | No | No |
| Optimism | Yes | Existing EVM path | No — not attempted yet | No | No |
| Near | Yes | Not yet built | No — not attempted yet | No | No |
| Injective | Yes | Not yet built | No — not attempted yet | No | No |
| Sei | Yes | Not yet built | No — not attempted yet | No | No |

"Provider available" here means: Wormhole's core Guardian network is confirmed live on that chain (`docs/interoperability-provider-evaluation.md`'s sourced comparison) — **not** that Inaya has deployed anything there. Polygon is the one honest exception: Wormhole has no "PolygonAmoy" entry, only an unrelated "PolygonSepolia" testnet — a real transfer attempt against it reverted on-chain (`InvalidTargetChain()`) before this was caught and corrected, see `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`.

Four chains have the real, end-to-end proof this table exists to distinguish from marketing — BSC, Ethereum/Sepolia, Arbitrum Sepolia, and Avalanche Fuji: `$INAYA` was actually locked on BSC Testnet and the wrapped equivalent confirmed, on-chain, in a real wallet on each destination. Solana, Sui, and Aptos each hit a real, different, chain-specific technical wall while attempting the same proof — not silently skipped, not rounded up to "done", and not left as an unexplained failure: each was traced to its exact, external root cause (Wormhole's own governance for Solana, the Wormhole SDK's own staleness for Sui/Aptos) — recorded in full in `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`'s `partialRoutes`. Every other cell stays "No" because that's the honest, current state.

The correct sentence to use anywhere user-facing, per the SOW's own instruction: *"Inaya's interoperability layer has 4 real, working routes via Wormhole (BSC to Ethereum, Arbitrum, and Avalanche), with more in active progress."* Not "Inaya supports 13 chains."
