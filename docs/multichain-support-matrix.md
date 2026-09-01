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
| Arbitrum | Yes | Existing EVM path | No — not attempted yet | No | No |
| Avalanche | Yes | Existing EVM path | No — not attempted yet | No | No |
| Polygon | **No — Wormhole has no real Amoy coverage** | Existing EVM path | No | No | No |
| Base | Yes | Existing EVM path | No — not deployed | No | No |
| Optimism | Yes | Existing EVM path | No — not deployed | No | No |
| Solana | Yes | Existing Phantom/Solflare path | No — not deployed | No | No |
| Sui | Yes | Not yet built (Sui-native wallet needed) | No — not deployed | No | No |
| Aptos | Yes | Not yet built (Aptos-native wallet needed) | No — not deployed | No | No |
| Near | Yes | Not yet built | No — not deployed | No | No |
| Injective | Yes | Not yet built | No — not deployed | No | No |
| Sei | Yes | Not yet built | No — not deployed | No | No |

"Provider available" here means: Wormhole's core Guardian network is confirmed live on that chain (`docs/interoperability-provider-evaluation.md`'s sourced comparison) — **not** that Inaya has deployed anything there. Polygon is the one honest exception: Wormhole has no "PolygonAmoy" entry, only an unrelated "PolygonSepolia" testnet — a real transfer attempt against it reverted on-chain (`InvalidTargetChain()`) before this was caught and corrected, see `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`.

BSC and Ethereum/Sepolia's "$INAYA transfer" cells are the one real, end-to-end proof this table exists to distinguish from marketing: 1.0 `$INAYA` was actually locked on BSC Testnet and the wrapped equivalent is confirmed, on-chain, in a real wallet on Sepolia. Every other cell stays "No" because that's the honest, current state — no deployment exists yet for those chains.

The correct sentence to use anywhere user-facing, per the SOW's own instruction: *"Inaya's interoperability layer has a real, working route from BSC to Ethereum via Wormhole, with 11 more evaluated networks in progress."* Not "Inaya supports 13 chains."
