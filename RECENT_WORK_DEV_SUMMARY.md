# Inaya Network — Recent Work Dev Summary (yesterday evening → today, 2026-09-01)

Internal team doc. Not committed to git (matches how we've handled every other internal-only
summary this session — ask before pushing anything like this). Same honesty convention as
`docs/chain-agnostic-audit.md`/`PROOF_OF_STORAGE_FIX_SUMMARY.md`: real transaction hashes, real
addresses, and an explicit line between what's proven and what's still pending, throughout.

## 1. Wormhole Interoperability Layer

A second, provider-based way to move $INAYA across chains, running alongside (not replacing) the
hand-rolled native bridge below.

- Evaluated Wormhole vs. LayerZero against live docs (`docs/interoperability-provider-evaluation.md`),
  selected Wormhole (WTT/lock-and-mint mode).
- **3 real, proven, end-to-end routes** (lock on BSC Testnet → wrapped token created and credited
  on the destination, verified on-chain both sides):
  - BSC → Ethereum Sepolia — lock `0xacfb69e7...`, complete `0x8ceb13dc...`
  - BSC → Arbitrum Sepolia — lock `0x259717c6...`, complete `0x3debb3eb...`
  - BSC → Avalanche Fuji — lock `0x81967c37...`, complete `0x608f7a1f...`
- A real bug found and fixed along the way: an early attempt used Wormhole's mainnet chain ID for
  Sepolia/Arbitrum instead of their real, separate testnet-specific IDs — caught by a real on-chain
  `InvalidTargetChain()` revert, fixed in `WormholeProvider.js`'s chain mapping.
- **Solana, Sui, Aptos routes via Wormhole were attempted and hit real, external blockers**: Solana
  needs a Wormhole guardian governance action (register BSC as a trusted source) that no integrator
  can perform; Sui and Aptos both hit stale, hardcoded bytecode/package references baked into
  Wormhole's own SDK (confirmed by re-running the actual attempts live and inspecting the exact
  on-chain abort). Full diagnostic trail in `deployments/interop/wormhole-wtt/bscTestnet-attestation.json`.
  **This is what led directly to §2 below** — since these three chains were blocked on Wormhole's
  side specifically (not fixable by us), we built Inaya's own native bridge to them instead, the
  same pattern that already worked for Solana.

## 2. Native Multichain Bridge — Hedera, Aptos, Sui (new today; Solana/BSC/Sepolia/Fuji/Arbitrum
already live going into today)

Inaya's own bridge (BSC home, mint/burn spokes elsewhere) — full control, no third-party
dependency, unlike the Wormhole layer above.

- **Hedera Testnet**: runs the EVM natively (Hedera Smart Contract Service), so the *exact same*
  Solidity contracts already proven on Sepolia/Fuji/Arbitrum were deployed unchanged — no new
  contract language needed. Real `bridgeOut` + `executeMessage` cycle proven on the first attempt:
  bridgeOut `0x44fe856c...`, executeMessage `0xd619dd27...`, 1.0 wrapped $INAYA confirmed delivered.
  One real Hedera-specific quirk found: a brand-new EVM account doesn't exist on Hedera's ledger
  until it receives its first inbound transfer — hit this with the relayer wallet, fixed by
  funding it first (and that first transfer costs real, materially more gas than a normal one,
  since it's paying for actual account creation).
- **Aptos Testnet**: brand-new native Move contract (`aptos/programs/inaya-bridge-aptos`), porting
  the same message-hash + threshold-signature scheme already proven on EVM/Solana. Aptos's native
  `secp256k1::ecdsa_recover` has no hidden hashing quirk (unlike Solana's precompile), so it reuses
  the *exact* validator-signing code every EVM spoke's relayer already uses. Compiled clean,
  deployed, and the real dry run worked on the **first attempt** — no crypto bugs at all. bridgeOut
  `0x01c34871...`, receive_message `0x519b033b...`, 1.0 $INAYA confirmed.
- **Sui Testnet**: same approach, new Move contract (`sui/programs/inaya_bridge_sui`). Had to grab
  a prebuilt Sui CLI (building from source hit a missing Windows `libclang` dependency). This one
  *did* hit a real bug, traced by comparing the actual failed on-chain transaction's decoded
  arguments against isolated Move unit tests: `ethers.toBeArray(0)` returns a zero-length array
  (minimal big-endian encoding of zero has no bytes), silently truncating every signature by one
  byte whenever a validator's recovery id was 0. Fixed in the relayer script, not the contract;
  two real transfers went through cleanly afterward. bridgeOut `0xb1cbf9aa...`, receive_message
  `5ysU3ojB...`.
- Registry (`registry.js`) updated to reflect real, proven `TOKEN_TRANSFER` level for all three —
  never claimed beyond what's actually verified on-chain, same discipline as every other chain in
  this registry. 22/22 chain-adapter tests passing.

## 3. Decentralized Storage Backup & Recovery Mechanism (new SOW, today)

Client asked for redundancy so a temporary storage-provider failure becomes an operational event,
not data loss — additive only, no change to the existing encryption/sharding pipeline.

**Real gap closed**: today, the two encrypted shards each file is split into ("Shard Alpha"/"Shard
Beta" — an all-or-nothing split, not erasure coding) were each pinned to exactly one provider
(Pinata). Losing that one pin permanently lost the file. Zero redundancy existed.

**What shipped**:
- Replica redundancy across two independent pinning providers (Pinata + **Filebase**, an
  S3-compatible, IPFS-backed provider on a genuinely different infrastructure/failure domain).
- Two-tier failure detection: cheap pin-status checks every 15 min with a 3-strike grace window
  (a single blip never triggers recovery), plus daily content-hash integrity checks that catch
  real corruption with zero grace.
- Five backup-health states (Protected/Rebuilding/Degraded/Recovery Required/Recovery Failed),
  computed by a pure, fully unit-tested state machine (19/19 tests).
- Integrity-verified automatic recovery: fetches from a surviving healthy replica, verifies its
  hash against what was captured at original pin time, re-pins to restore the target count, and
  now also actually deletes the failed replica's underlying storage object (not just its database
  record) — closing a real storage-efficiency gap found while proving this out.
- New `InayaBackupRegistry.sol` contract (deployed live: `0x062c341aE4f11CB1dEa1B0D3930d52902F97f48a`,
  BSC Testnet), recording only a redundancy commitment and health-state transitions on-chain — never
  the replica data itself — written only at real state boundaries, mirroring `InayaProofRegistry`'s
  existing trust model. 15/15 contract tests.
- New `InayaKernel.Backup` SDK client (`getBackupStatus`/`getBackupHealth`/`getRedundancyStatus`/
  `getRecoveryStatus`/`requestRecovery`), 9/9 tests, published to npm (see §5).

**Real, live, end-to-end proof — both providers, full cycle**: replicated a real, already-uploaded
asset's shards to both Pinata and Filebase for real (correctly computed `Protected`, matching
on-chain transaction confirmed independently); then deleted a real Filebase replica, watched the
system correctly detect it (`Recovery Required`), fetch from the surviving Pinata copy, verify its
hash, re-pin to Filebase, and self-heal back to `Protected` — with the on-chain registry tracking
every real state transition along the way.

**Two real bugs found and fixed by that exact proof run** (the state machine itself was already
correct and unit-tested; both were in the coordinator's usage of it):
1. The recovery sweep checked each shard's health by wrapping it through the two-shard combiner
   with a *fake empty* replica list standing in for the other shard — which always read as the
   worst possible state, so every shard of every asset in the queue got a recovery attempt whether
   it needed one or not.
2. Recovery's source/target-provider selection required a replica to have *exactly zero* recorded
   failures ever, instead of the same "still retrievable" definition used everywhere else — so a
   perfectly fine replica that had merely had one transient blip could get wrongly excluded.

**Two real, live-account gotchas** hit and fixed while wiring in Filebase, neither a bug in our
code: the correct S3 endpoint is `s3.filebase.io` (not `.com`), and the AWS SDK's newer default of
auto-attaching a request checksum causes a generic `AccessDenied` against Filebase's backend.

**Also found, real and external**: the project's Pinata account is over its plan's usage limit
(confirmed via a live 403 from Pinata's own API) — this blocked the very first attempt at a fresh
live pin and is worth addressing on the account side.

Full writeup: `docs/backup-redundancy-architecture.md`.

## 4. custody-sdk — Backup client shipped to npm

- `@inaya-network/custody-sdk@1.0.7-beta` published to npm, now under **both** the `beta` and
  `latest` dist-tags — a plain `npm install @inaya-network/custody-sdk` now resolves to it.
- Real snag along the way: `1.0.6-beta` was already live on the registry from an unrelated session
  a week earlier and didn't contain today's `backup.js` at all — npm versions are immutable, so a
  fresh version number (`1.0.7-beta`) was needed rather than republishing over it.
- README.md and SDK_GUIDE.md updated to match.

## 5. Business Workspace — Light theme redesign

- Replaced the old stark white/near-black "White" theme with a warmer, more deliberate ivory +
  deep-teal palette (relabeled "Light" in the UI — the stored preference key stays `white` so
  anyone with it already saved in localStorage doesn't silently fall back to Dark).
- Found and fixed the real structural cause the theme was reading as "broken": ~50 hover/icon-
  container/border classes on the dashboard were hardcoded to a *white*-tint overlay
  (`bg-white/5`, `border-white/10`, etc.) — fine against the dark/neon surfaces they were designed
  for, nearly invisible against a light one. Added theme-aware `--inaya-overlay-{5,10,15}` tokens
  (dark/neon keep their exact existing values, so nothing changes for those two themes) and swapped
  every hardcoded instance on the dashboard to use them.
- Verified live in the running app (computed CSS values match the new tokens exactly) and via a
  faithful before/after mockup of the actual dashboard markup; a full authenticated-dashboard
  screenshot wasn't captured (needs a real login this session can't perform), so give it a look
  once you're signed in.

## Verification summary across all of the above

| Area | Tests | Status |
|---|---|---|
| Native bridge (chain-adapters) | 22/22 | passing |
| Backup contract (`InayaBackupRegistry`) | 15/15 | passing |
| Backup health state machine | 19/19 | passing |
| Backup SDK client | 9/9 | passing |
| dApp production build | — | clean |

Every real transaction hash, contract address, and bug fix above is cited exactly as recorded —
nothing rounded up. Deployment records: `deployments/bridge/{hederaTestnet,aptosTestnet,suiTestnet}.json`,
`deployments/interop/wormhole-wtt/bscTestnet-attestation.json`.
