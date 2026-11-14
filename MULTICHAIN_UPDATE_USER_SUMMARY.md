# Inaya goes real multi-chain — today's update

Big update today: $INAYA now moves across chains for real — not just wired up, actually tested with real transactions you can look up yourself.

## What's new

**Solana now fully works.** This is the headline: $INAYA can now move from BSC to Solana and arrive, verified, in a wallet — the first time this has ever actually worked end-to-end. Getting there meant finding and fixing three real bugs, including one deep, undocumented issue in how Solana verifies signatures. All fixed, all real, all on-chain.

**Avalanche and Arbitrum now proven too**, on Inaya's own bridge — real transfers sent and confirmed, not just "the contracts exist."

**A second way to move $INAYA: Wormhole.** Inaya is now also connected to Wormhole, one of the most widely-used cross-chain networks in crypto — the idea is to reach many more blockchains over time without Inaya having to hand-build a bridge for every single one. Three real, working routes today: BSC to Ethereum, Arbitrum, and Avalanche, all via Wormhole, all tested with real transactions.

**Fixed**: a readability bug where some text on the Business Workspace dashboard was nearly invisible on the White theme.

## Chains $INAYA can move to right now, for real

| Chain | Status |
|---|---|
| BSC (home) | ✅ |
| Ethereum (Sepolia) | ✅ real transfer proven (two separate ways) |
| Avalanche (Fuji) | ✅ real transfer proven (two separate ways) |
| Arbitrum (Sepolia) | ✅ real transfer proven (two separate ways) |
| **Solana Devnet** | ✅ **real transfer proven today — new** |
| Sui | Evaluated, blocked on a third-party issue we can't fix ourselves |
| Aptos | Evaluated, blocked on a third-party issue we can't fix ourselves |
| Polygon | On hold (needs test funds) |

For Sui and Aptos: we traced both down to real, specific bugs in Wormhole's own published software (not something wrong on Inaya's side) — one is stale pre-compiled code that predates a recent network upgrade, the other is a similar mismatch. Filed clearly, but the fix has to come from Wormhole, not us.

## This is still testnet

Everything above is on testnet — this is Inaya proving the whole system out for real before anything touches mainnet. No real funds are involved yet.
