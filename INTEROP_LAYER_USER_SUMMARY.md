# $INAYA can now move through Wormhole — a real cross-chain transfer, verified

We've started connecting Inaya to Wormhole, one of the most widely-used cross-chain networks in crypto — the idea is to eventually reach a large number of blockchains without Inaya having to hand-build a custom bridge for every single one.

## What actually happened, not just planned

This isn't a mockup or a "coming soon" — we ran a real transfer, start to finish, on testnet:

- 1.0 $INAYA was locked on BSC Testnet
- Wormhole's network picked it up and signed off on it
- The equivalent wrapped $INAYA arrived, verified, in a wallet on Ethereum (Sepolia) — a real ERC-20 token, `Project Inaya` / `INAYA`, 18 decimals

Every step is a real on-chain transaction you can look up yourself, not a claim.

## Where you can see it

The `/bridge` page now has a **Wormhole Interop Layer** section, separate from Inaya's existing bridge. Right now it offers exactly one route — BSC to Ethereum — because that's the one we've actually proven works. Every other network Wormhole reaches is listed for reference, honestly labeled as not yet transfer-ready, rather than offered as if it already worked. We'd rather under-promise here than have something look connected when it isn't.

## What's next

- More routes: Arbitrum and Avalanche are the natural next two, since Inaya already has a presence on both.
- Wider chain support: Solana, Sui, Aptos, and others are on Wormhole's network and evaluated — not yet wired up.
- Everything above is testnet only. No real funds are involved yet — this is Inaya proving the system out before anything touches mainnet.
