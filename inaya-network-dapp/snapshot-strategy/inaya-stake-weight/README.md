# inaya-stake-weight

A Snapshot strategy scoring each voter by their real `InayaStaking` stake x
lock-tier multiplier (Flexible 1.00x / 30-day 1.25x / 90-day 1.50x) — the
same formula `InayaStaking.earned()` already uses for reward boosts, and the
same formula `src/lib/voteWeight.js` (used elsewhere in this repo) computes
via individual calls. This package computes it via a real, on-chain-verified
batched [Multicall3](https://www.multicall3.com/) read instead, since a
Snapshot space may need to score thousands of voters in one pass.

**Verified against live BSC testnet data** (see git history for the
throwaway check this was validated with): `multicall.js`'s batched result
matched three individual `userStakedBalance`/`lockMultiplierBps` calls
exactly, for both a staked address and two zero-stake addresses.

## This is Governance Charter Phase 1

Per the charter, Phase 1 ("Post-TGE") uses Snapshot-style gasless signal
votes — non-binding but publicly honored — before any on-chain binding vote
exists (that's Phase 2, see `contracts/governance/InayaGovernor.sol`, which
is written but explicitly not deployed yet either).

## This code existing here does NOT make it live

Snapshot spaces can only use strategies from one of two places:

1. **The published `@snapshot-labs/snapshot-strategies` package.** The
   standard path: open a PR against
   [snapshot-labs/snapshot-strategies](https://github.com/snapshot-labs/snapshot-strategies)
   adding this strategy (their repo has its own contribution template —
   `index.js` + `schema.json` + `examples.json`, which is exactly the shape
   used here so the port should be close to copy-paste). Once merged, any
   Snapshot space, not just Inaya's, can select `inaya-stake-weight` from
   the strategy picker UI. Slower (depends on their review queue) but zero
   ongoing infrastructure to run.
2. **A self-hosted [score-api](https://github.com/snapshot-labs/score-api)
   instance** with this strategy registered locally. Faster to stand up,
   but Inaya then owns keeping that service running and available whenever
   anyone loads the space's voting page.

Neither has been done — this package is the code artifact for whichever
path is chosen, not a live integration.

## Setup for a real Inaya Snapshot space

1. Create the space at [snapshot.org](https://snapshot.org) (or self-hosted),
   pointed at whatever address/ENS should administer it — a natural fit is
   the same Security Council Safe discussed in
   `scripts/governance/enumerate-ownership.mjs`'s output, once that
   decision is made.
2. Add this strategy to the space's `strategies` array once it's available
   via one of the two paths above:
   ```json
   {
     "name": "inaya-stake-weight",
     "network": "97",
     "params": {
       "stakingAddress": "0xc465279444Cb0E10c69D0769CDae31E457eA660f"
     }
   }
   ```
   (Swap the network/address for mainnet's once `InayaStaking` is deployed
   there — this example uses the current BSC testnet deployment.)
3. **Staker-facing caveat, same one `InayaVotingPower.sync()` in Phase 2
   has**: this strategy reads `InayaStaking` state directly at whatever
   block the proposal snapshots, so there is nothing for a staker to
   "activate" the way Phase 2's checkpoint token requires delegation — it
   just reflects real stake at that block. No action needed from voters
   beyond having staked before the snapshot block.
