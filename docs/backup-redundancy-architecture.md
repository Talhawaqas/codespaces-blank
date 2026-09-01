# Inaya Decentralized Storage Backup & Recovery Mechanism

Internal architecture doc for the Backup & Recovery Mechanism SOW. Same honesty/rigor convention
as `docs/chain-agnostic-audit.md` and `PROOF_OF_STORAGE_FIX_SUMMARY.md`: what's real vs. what's
still pending is stated explicitly throughout, never rounded up.

## 1. What this is additive to

Today, a file is encrypted client-side, split into two ciphertext halves ("Shard Alpha"/"Shard
Beta" — an all-or-nothing 2-of-2 bisection, **not** erasure coding), and each half is pinned to
exactly one storage provider (Pinata). Losing that one pin permanently loses the file. A separate
on-chain node-operator registry and heartbeat daemon (`@inaya-network/node-daemon`) exist, but by
its own documentation that daemon does not store or serve shard bytes — it never has.

This mechanism adds **replica redundancy across independent pinning providers** for the two
existing shards, automated health monitoring, integrity-verified recovery, and an on-chain
redundancy/health commitment record — wrapping the existing upload/download flow without changing
its crypto or sharding logic at all.

## 2. Redundancy model: provider diversity, not erasure coding

Each shard (Alpha/Beta) is replicated across a configurable number of independent pinning
providers (`BACKUP_TARGET_REPLICA_COUNT`, default 2). Today that means Pinata (already real,
already the primary pin) plus **Filebase** (S3-compatible, IPFS-backed via Storj/Sia — a
genuinely different infrastructure/failure domain than Pinata's own cluster, which is the actual
point of provider diversity).

Real erasure coding (Reed-Solomon/zfec — turning 2 shards into k-of-n fragments) was considered
and rejected for this pass: it would require rewriting the crypto/sharding pipeline in three
parallel implementations (web `page.js`, `clientCrypto.js`, `custody-sdk/src/crypto.js`) and
changing `InayaCustody`'s fixed 2-CID-per-asset shape — a genuine architecture replacement, which
this SOW's own "additive only" principle rules out.

**Honest limitation, stated plainly**: this only adds redundancy *within* each existing shard. It
does not change the underlying 2-of-2 bisection — if Alpha and Beta both independently lose every
replica, the file is still unrecoverable, exactly as before this mechanism existed. True
cross-shard redundancy needs real erasure coding, out of scope here.

**Second provider status**: Filebase is fully coded (`src/lib/pinningProviders/filebase.js`) but
not yet live — `FILEBASE_ACCESS_KEY`/`FILEBASE_SECRET_KEY`/`FILEBASE_BUCKET` have not been
supplied. `pinningProviders/index.js`'s `listAvailableProviders()` only returns providers whose
credentials are actually present, so today the system correctly reports every asset as **Degraded**
(1 of 2 target replicas) rather than falsely claiming Protected — the health-state machine was
verified to behave exactly this way against real data (see §7).

## 3. Failure detection — two tiers

- **Tier 1 (`api/backup/cron/check-pins`, every 15 min)**: cheap pin-status check per replica
  (Pinata's `pinList` query API; Filebase's `HeadObject`) — confirms the provider still reports
  holding the content, without downloading it. A single miss does **not** fail a replica —
  `CONSECUTIVE_FAILURE_THRESHOLD` (default 3) consecutive misses are required before a replica
  flips to "unreachable" (`src/lib/backupHealth.js`). This is the concrete answer to the SOW's
  "temporary network interruptions must not immediately trigger permanent recovery" requirement.
- **Tier 2 (`api/backup/cron/verify-integrity`, daily, batched/rotated)**: actually fetches
  replica bytes and compares a SHA-256 hash captured at pin time. Rotated (oldest-checked-first,
  bounded per run) so a large asset base isn't fully re-fetched every day. A mismatch is real
  corruption and is **never** given grace — it flips a replica to "failed" immediately.

## 4. Backup-health states

| State | Concrete condition |
|---|---|
| **Protected** | Retrievable replicas ≥ target R for both shards, and the most recent Tier-1 check succeeded for every recorded replica. |
| **Rebuilding** | A re-pin job is actively in-flight for at least one shard. |
| **Degraded** | Fewer retrievable replicas than target, but nothing has actually failed (e.g. the second provider was never configured, or a replica is mid-grace-window) — the shard is still fully retrievable today. |
| **Recovery Required** | A replica crossed the failure threshold (or failed Tier 2), dropping retrievable count below target, but at least one healthy replica of that shard still exists. |
| **Recovery Failed** | Zero retrievable replicas for a shard, or a recovery attempt itself exhausted its options. Needs manual intervention — cannot self-heal. |

Asset-level state is the **worst of both shards** (`combineShardStates` in `backupHealth.js`) — a
file is only as protected as its weaker shard, since both are required to reconstruct it.

## 5. Recovery workflow

`api/backup/cron/recover` (every 10 min) finds every asset in Recovery Required, and for the
affected shard: fetches content from any other currently-healthy replica of the **same** shard,
recomputes its SHA-256 and requires an exact match against the hash captured at original pin time
(rejecting and leaving the shard in Recovery Required on any mismatch — recovered data is never
accepted on trust), then re-pins to whichever configured provider doesn't already hold a healthy
replica, restoring the target count.

This deliberately does **not** reuse the existing Merkle-proof registry (`InayaProofRegistry.sol`
/ `src/lib/merkle.js`) for integrity verification — that mechanism chunks the *pre-split, full*
ciphertext into 256KB leaves, an entirely different granularity than a single shard's content
hash, and isn't wired to fetch per-chunk data from IPFS today regardless. A direct SHA-256 over
the raw shard string is simpler, provider-agnostic (unlike CID equality — different providers can
address identical bytes with different CIDs), and matches exactly what recovery needs to check.

A user can also request an immediate recovery attempt via `requestRecovery()` rather than waiting
for the next cron pass — wallet-signature authenticated exactly like every other file-keyed
mutation in this codebase, reusing `metadata-auth.js`'s existing `verifyMetadataAuth`/
`verifyOnChainFileOwner` helper rather than reimplementing signature verification.

## 6. On-chain scope

`contracts/InayaBackupRegistry.sol` — a new, separate contract (not an extension of
`InayaProofRegistry`, whose write-once Merkle-root data model doesn't fit repeatedly-updated
health state). Per fileHash, stores only: `targetReplicaCount`, `replicaSetHash` (a hash of the
current replica-provider topology — the topology itself stays off-chain), `healthState` (the
5-value enum above), and timestamps — never the replica CIDs, content hashes, or provider
identities themselves, matching the SOW's "no large backup data on-chain" scope limit exactly
(the same pattern `InayaProofRegistry` already uses for its Merkle root vs. chunk data).

Every write is `onlyOwner` (the backend coordinator), cross-checking the asset's real owner
against `InayaCustody.assets(fileHash)` at registration time — the same **Path A centralized-trust**
model `InayaProofRegistry.verifyChunkProof` already uses and documents honestly (there is no
staked, decentralized set of health-reporters to trust instead yet). On-chain writes happen only
at state-machine **boundary crossings** (a real transition), never on every routine poll — the
concrete answer to the SOW's storage-efficiency requirement, applied to on-chain gas cost.

Deployed to BSC Testnet 97 only (same as `InayaCustody`/`InayaProofRegistry` today). Real deployed
address: `0x062c341aE4f11CB1dEa1B0D3930d52902F97f48a`.

## 7. Real verification performed

- **Contract**: `Test/InayaBackupRegistry.test.js`, 15/15 passing — registration, updates, health
  transitions (including the full Protected→Degraded→RecoveryRequired→Rebuilding→Protected
  lifecycle), the no-op-on-unchanged-state gas-saving path, and full access-control coverage
  (including that even the asset's own owner cannot call the backend-operator-only functions).
- **Health state machine**: `test/backup-health.test.mjs`, 19/19 passing — every state transition,
  the grace-window distinction between "wavering" (temporary) and "unreachable" (crossed
  threshold), Tier-2 corruption bypassing grace entirely, and the worst-of-both-shards combiner.
- **SDK**: `custody-sdk/test/backup.test.mjs`, 9/9 passing — request shape for every read method,
  `requestRecovery()`'s signed-message construction, and error translation.
- **Real deployment + real on-chain interaction**: `InayaBackupRegistry` deployed live to BSC
  Testnet 97 (`0x062c341aE4f11CB1dEa1B0D3930d52902F97f48a`).
- **Real end-to-end run** (`scripts/backup-mechanism-e2e-proof.mjs`): run against a real,
  already-registered `InayaCustody` asset (real on-chain `assets()` read, real IPFS shard content
  fetched from public gateways), through the real `backupEngine.replicateShard()` /
  `getBackupStatus()` / `runCheckPinsSweep()` pipeline, ending in a real
  `InayaBackupRegistry.registerRedundancyCommitment()` transaction — full result, including the
  real transaction hash and the exact asset used, recorded in this session's own summary. Honestly
  scoped to what's provable with only Pinata configured: correctly computes and records
  **Degraded** (1 of 2 target replicas — Filebase not yet configured), not a false "Protected."
  Proving the full outage-simulation → Recovery Required → recovered → Protected cycle needs a
  second real, live provider and is deferred to Phase 2, once Filebase credentials are supplied.

## 8. What's explicitly out of scope for this pass

Real erasure coding; the not-yet-built node-shard-serving system (this mechanism never depends on
it); more than 2 providers; geographic redundancy; cross-region recovery; enterprise backup
policies; scheduled recovery drills; cryptographic proof-of-redundancy/recovery; cross-chain
recovery coordination; an automated on-chain challenge loop (Tier-2 stays coordinator-side,
consistent with `InayaProofRegistry.verifyChunkProof` already being manual-only); multi-chain
deployment of `InayaBackupRegistry` beyond BSC Testnet 97. All of these are the SOW's own named
"Future Extensions" or genuinely separate undertakings.

## 9. Where things live

- Contract: `contracts/InayaBackupRegistry.sol`, deployed via `scripts/deploy-backup-registry.cjs`
- Contract tests: `Test/InayaBackupRegistry.test.js`
- Health state machine: `inaya-network-dapp/src/lib/backupHealth.js`, tests in `inaya-network-dapp/test/backup-health.test.mjs`
- Pinning provider adapters: `inaya-network-dapp/src/lib/pinningProviders/{index,pinata,filebase,hash}.js`
- Coordinator engine: `inaya-network-dapp/src/lib/backupEngine.js`
- API routes: `inaya-network-dapp/src/app/api/backup/{replicate-shard,status,recovery-status,recover}/route.js`, `.../cron/{check-pins,verify-integrity,recover}/route.js`
- Cron schedule: `inaya-network-dapp/vercel.json`
- SDK: `custody-sdk/src/backup.js` (`InayaKernel.Backup`), tests in `custody-sdk/test/backup.test.mjs`
- Upload-path wiring: `inaya-network-dapp/src/app/api/upload/route.js`, `inaya-network-dapp/src/app/page.js` (`uploadToPinata`/`prepareShardedFile`)
- Real end-to-end proof script: `scripts/backup-mechanism-e2e-proof.mjs`
