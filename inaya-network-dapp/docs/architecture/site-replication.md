# Site replication and failover readiness

Code: `src/lib/ha/replication.js`, route `src/app/api/orgs/replication/`, panel `ReplicationPanel.js` (Settings). It builds on the backup engine's replica records and the resilience layer; it adds a replication profile and measurements.

## What it is

**Active-passive.** One primary storage provider holds the encrypted shards; one to three secondaries hold read-only replicas. A "site" is a pinning provider that holds replicas (the same providers the backup engine replicates to). Active-active operation is not provided and is not claimed.

## What is measured, and how

| Measure | Source |
|---|---|
| Replication state per secondary (NO DATA, SYNCED, LAGGING, BEHIND TARGET, STALE, CONFLICT, ERROR) | the organization's files joined to `backup_replicas`: a healthy replica at the primary and at the secondary |
| Lag and backlog | files with a primary replica but none at the secondary; lag is the age of the **oldest** such file |
| RPO exposure | that same age: the real data-loss window if the primary were lost now. Compared with the target |
| Staleness | last replica check older than 24 hours |
| Conflict | the same shard has different content hashes at primary and secondary |
| Recovery test | reads a **sample** of files back from the secondary and verifies each against the hash taken at pin time; timed |
| Last verified restore | the last passing recovery test |

A secondary with no replica records reports **NO DATA**, never "healthy".

## Failover readiness

A list of **blockers**: not in sync, no data, never tested, last test failed, last passing test older than 30 days. "No blockers" is not a promise. **Failover is a manual operator procedure** (see the disaster-recovery runbooks). Nothing here switches traffic.

## Honest limits

* The recovery-test time covers the sampled files only. It is **not** extrapolated into a full-site recovery time, and the evidence says so.
* Replica records are refreshed by the scheduled pin and integrity checks, so state is as fresh as those checks.
* Failed tests and a secondary falling behind its RPO target alert administrators (once per day per site).

## Evidence

`GET /api/orgs/replication/evidence` returns a JSON package with the profile, measured state, recent tests, the audit-chain verification result, explicit statements of what it does not show, and a SHA-256 over the whole package. Exporting is recorded.
