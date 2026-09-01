# Interop Layer Security Boundary

Interop SOW, Phase 9. Which security responsibilities belong to Inaya, and which belong to Wormhole, once the interop layer (`docs/inaya-interoperability.md`) actually carries a real transfer. Written now, before any deployment, so the boundary is decided deliberately rather than discovered by accident later.

## What Wormhole's infrastructure is responsible for

- **Message attestation.** A transfer is only valid once 13 of 19 independent Guardians have signed the same VAA (Verified Action Approval). Inaya does not re-implement or second-guess this — a valid VAA is trusted as Wormhole's own security guarantee, the same way Inaya's own bridge trusts a 2-of-3 quorum from `InayaValidatorSet.sol` on its native routes.
- **Guardian-network liveness and honesty.** Inaya has no control over, and takes no responsibility for, Guardian uptime or the 13/19 threshold's continued security — that risk is inherent to choosing Wormhole (documented explicitly in `docs/interoperability-provider-evaluation.md`'s recommendation, not hidden).
- **Relaying**, when automatic relay is used — Wormhole's relayer network submits the destination transaction. If self-relay is used instead, this responsibility shifts to Inaya's own cron infrastructure (mirroring `api/bridge/cron/relay-messages`'s existing role for the native bridge).
- **Destination-chain contract correctness** for the standard Token Bridge / NTT framework contracts themselves — these are Wormhole's own audited contracts, not Inaya-authored code.

## What Inaya is responsible for

- **Which routes are exposed at all.** `src/lib/chain-adapters/interop/capabilityRegistry.js` is Inaya's own gate — a chain being reachable on Wormhole's network does not mean Inaya's frontend offers it (see `docs/multichain-support-matrix.md`'s Tier classification). This is Inaya's control, not Wormhole's.
- **Transfer uniqueness and idempotency on Inaya's own side.** `src/lib/interopTransfers.js`'s `_id = transferId` upsert pattern prevents Inaya's own backend from double-recording the same transfer, independent of whatever replay protection Wormhole's VAA scheme already provides on-chain — defense in depth, not reliance on a single layer.
- **Correct status mapping.** Wormhole's own transfer lifecycle (source confirmed → attested → relayed → executed) is translated into Inaya's `PENDING`/`PROCESSING`/`ATTESTING`/`RELAYING`/`COMPLETED`/`FAILED` vocabulary (`src/lib/interopTransfers.js`'s `INTEROP_TRANSFER_STATUS`). A mistranslation here is an Inaya bug, not a Wormhole one.
- **Rate limiting and supply-cap enforcement on Inaya's own token contracts.** If NTT is deployed in burn-and-mint mode, the burn/mint authority is Inaya's own contract, and Inaya's own logic (not Wormhole's) is what prevents unauthorized supply creation — Wormhole only guarantees the message saying "mint X on chain Y" was genuinely authorized by a burn on chain X; it does not independently enforce Inaya's supply cap.
- **Which chain's data is authoritative for a completed transfer.** Same principle the native bridge already follows (`api/bridge/cron/index-events`'s comment: "authoritative completion status comes from the destination chain's own event, not from submitting the transaction") — a transfer isn't `COMPLETED` in `interop_transfers` until the destination chain itself confirms it, not merely because Inaya submitted a relay transaction.

## What's explicitly NOT re-implemented

Per `docs/chain-adapters.md`'s existing security-requirements list (which this section extends, not replaces): Inaya does not reimplement Guardian-equivalent multi-party signing for interop-layer transfers — that would defeat the entire reason to use a third-party interoperability network instead of extending Inaya's own validator set to every new chain by hand. The tradeoff is explicit and accepted: interop-layer routes trust Wormhole's Guardian network as their root of trust; native-bridge routes trust Inaya's own `InayaValidatorSet.sol`. Both are documented, neither is hidden, and a user-facing surface should make clear which one a given route uses (a follow-up for Phase 6's frontend work, not yet built).

## Finality

Wormhole's own per-chain finality thresholds (queried live via `@wormhole-foundation/sdk-base`'s `finality.finalityThreshold()` — e.g. 15 blocks on BSC, 32 slots on Solana, 4096 blocks on Arbitrum, verified in `src/lib/chain-adapters/interop/WormholeProvider.js`) are what the Guardian network itself waits for before attesting. Inaya does not need a separate finality check for interop-layer transfers the way `docs/chain-adapters.md` documents for the native bridge's `getFinalityStatus()` — Wormhole's attestation already encodes "this source-chain event is final," so re-checking it in Inaya's own indexer would be redundant, not additional safety.
