# Smart Cloud Backup & Health Scheduler

**Status:** Implemented and tested. **Date:** September 2026.
**SOW:** Modular Enterprise Adoption Features, Feature 3.

## Phase 0 Audit — What Already Existed

| Capability | Status before this feature | Treatment |
|---|---|---|
| A real, modular cloud-migration engine — source adapters for AWS/Azure/GCS, retry+backoff, size-verified integrity check | Fully built, in the sibling `inaya-migration-agent` package | Reused directly via a `file:` dependency link, not rewritten or forked |
| Recurring, incremental (changed-objects-only) sync against a customer's own cloud bucket | **Did not exist** | Built |
| Per-schedule health monitoring (stale/degraded/failed detection) | **Did not exist** | Built |
| Encrypted-at-rest storage of a customer's own cloud credentials, scoped to a recurring job | **Did not exist** — `inaya-migration-agent`'s own design explicitly keeps credentials local to a single CLI invocation, never persisted | Built, as a deliberate, disclosed departure from that design (see below) |
| A generic Vercel Cron + `CRON_SECRET` gate pattern | Established (`/api/cron/*`, `/api/backup/cron/*`) | Reused unchanged for `/api/cron/cloud-backup-run` |

## The Architectural Decision: Reuse the Real Migration Engine, Not Reimplement It

`inaya-migration-agent` is genuinely modular — `runMigration()`, the three cloud source adapters, and the Inaya destination client are all real, already-built code — but the package was not reachable from `inaya-network-dapp`'s Vercel deployment at build or runtime, since only the configured project directory's own `node_modules` graph is meaningful there.

Two options existed: build a scoped-down sync directly inside `inaya-network-dapp` (duplicating logic that already exists and is already correct), or make the real package genuinely reachable. The second is the stronger fix — it prevents future drift between two independent implementations of the same sync/retry/verify logic, and satisfies the SOW's own explicit instruction not to rewrite the migration engine. It was chosen after direct confirmation with the org's owner.

The lightest version of that fix was used: `"@inaya-network/migration-agent": "file:../inaya-migration-agent"` added to `inaya-network-dapp/package.json`, rather than a full npm/yarn workspace restructure. Vercel clones the complete git repository (not only the configured Root Directory), so the sibling package's files are physically present at build time even though build commands execute from within `inaya-network-dapp/`. Verified locally: `npm install` resolves the link, every real export (`runMigration`, `createAwsSource`, `createAzureSource`, `createGcsSource`, `createInayaDestination`, `Manifest`) imports correctly, and `npm run build` succeeds with the new dependency in place. The one residual, honestly-flagged uncertainty: this environment cannot directly inspect the live Vercel project's own settings to confirm its clone behavior matches the documented default.

## Two Real Gaps in the Reused Engine, Resolved Without Modifying It

`inaya-migration-agent` was designed for a one-time, operator-run migration, not a recurring, unattended job. Two of its own design choices are correct for that original purpose and wrong for this one:

1. **`Manifest` is a local JSON-Lines file** (`node:fs`) — meant for a human operator's own machine. Vercel's serverless filesystem does not persist between invocations, so a file-backed manifest would forget everything after every single run.
2. **`Manifest.isDone(key)` is permanent once true** — correct for "never re-migrate something already moved," wrong for a recurring backup where the *same* source object can legitimately change and needs to be re-copied.

Both are resolved entirely inside `cloudBackupScheduler.js`, without touching the shared package: a new `backupObjectState` Mongo collection records each object's real `size`/`etag`/`lastModified` after every successful copy. Before calling `runMigration()`, the scheduler does its own diff against that collection (`diffAgainstLastSync()`) and passes only the changed/new keys through `runMigration()`'s own `objectKeys` parameter — so a duck-typed shim manifest satisfying `runMigration()`'s exact `{isDone, record, summary}` interface can honestly always answer `isDone() → false` (nothing in the pre-filtered candidate list has been decided "done" yet), while its `record()` persists the real per-object outcome (`runMigration()`'s own verified byte size, retry count, success/failure) into `backupObjectState` for the *next* run's diff. Per the SOW's own explicit caution, the diff never trusts a timestamp alone — both size **and** etag must match a prior record for a key to be skipped.

## Credential Handling — A Disclosed Trust Shift

`inaya-migration-agent`'s own stated design keeps both source and destination credentials local to the process that runs it — the platform never sees them. A schedule that re-runs itself hours or days later cannot honor that property structurally; nothing can re-authenticate later without the platform holding a way to do so.

`backupCryptoAndCredentials.js` stores a customer's own cloud-source credentials (AWS/Azure/GCS) envelope-encrypted at rest — AES-256-GCM, `iv(12)+authTag(16)+ciphertext` as one base64 string, matching `integrationCrypto.js`'s established shape — under a key (`BACKUP_ENCRYPTION_KEY`) dedicated solely to this feature, distinct from every other secret class in the codebase, per this codebase's own "one key per secret class" rule. The only decrypt path (`resolveBackupCredential()`) is called exclusively from inside a scheduled run itself, never exposed through any route that returns to a client; `listBackupCredentials()` never returns the encrypted value at all. This is a genuine, deliberate departure from the migration tool's own guarantee, documented here plainly rather than implied to be equivalent to it.

## Destination Writes — In-Process, Not a Self-Referential HTTP Round Trip

`inaya-migration-agent`'s own `createInayaDestination()` is an HTTP client, built for an external CLI process talking to Inaya over the network. Since `cloudBackupScheduler.js` runs in-process inside `inaya-network-dapp` itself, `buildInayaDestination()` calls `s3-compat/store.js`'s `putS3Object`/`headS3Object` directly — the exact same functions every other S3-compatible write path in this app already uses — rather than round-tripping the write through its own API over HTTP.

## What Was Built

- **`src/lib/backupCryptoAndCredentials.js`** — envelope-encrypted credential storage/retrieval/revocation, owner/admin-gated, fully audited.
- **`src/lib/cloudBackupScheduler.js`** — schedule CRUD, the incremental diff, the shim-manifest bridge into the real `runMigration()`, health computation (`HEALTHY`/`WARNING`/`DEGRADED`/`FAILED`/`PAUSED`/`UNKNOWN`, based on consecutive failures and staleness relative to the schedule's own interval), and `findDueSchedules()` for the cron sweep.
- **API routes** — `backup-credentials` (list/store/revoke), `backup-schedules` (list/create/pause/resume/delete/run-now/run-history), and the `CRON_SECRET`-gated `/api/cron/cloud-backup-run` sweep, added to `vercel.json` on a 15-minute schedule.
- **`src/components/business/CloudBackupSchedulerView.js`** — a Business Workspace view: credential management, schedule creation and lifecycle (pause/resume/delete/run now), a per-schedule health badge, and expandable run history. Registered in `business/page.js`'s nav under Enterprise as `cloudBackup` — the same key `notifyScheduleOwners()`'s own failure-notification deep link (`actionUrl: "/business?view=cloudBackup"`) already assumed before the UI existed.

## A Real Bug Found and Fixed During Testing

The first version of `runBackupJob()`'s return/persisted-run shape computed both `objectsSeen` and `objectsChanged` from the same value (`changedKeys.length`), so a run's "seen" count silently equaled its "changed" count instead of reflecting every object actually listed from the source. A run with zero changes reported `objectsSeen: 0` even though the source was genuinely examined. Caught by a test asserting `objectsSeen` on a no-op second run; fixed by tracking `seenKeys.size` separately through `diffAgainstLastSync()` and threading it through as its own field.

## Testing

`test/cloud-backup-scheduler.test.mjs` — 12 tests, all passing against the real database and real S3-compatible storage write path. The cloud source itself is the one genuinely external dependency (no real AWS/Azure/GCS account is available in this environment), so it is replaced with an in-memory fake via Node's `--experimental-test-module-mocks` (`mock.module()`, following the exact precedent already established in `test/mfa.test.mjs`) — everything downstream of that one substitution is real: the diff-against-last-sync logic, the Mongo-backed manifest shim, the real `runMigration()` engine from the linked package, and the real destination write-and-verify through `s3-compat/store.js`. Coverage includes: credential encryption round-trip and revoke-then-resolve returning `null` (security), schedule CRUD and permission gating, health-status computation across all six states, a full new-object copy verified against real storage, duplicate-safety on a second run with zero source changes, a mixed run that re-copies only the objects that actually changed, due-schedule filtering, a paused-schedule rejection, and a revoked-credential failure that still durably records the run.

Production build compiles cleanly with the new routes and UI view registered.

## Known Limitations / Explicitly Deferred

- **Large objects are fully buffered in memory** — `putS3Object` requires a complete buffer, not a stream, so very large source objects are read entirely into memory before being written. Acceptable for the object sizes this feature targets; a genuinely large-object streaming path was not built in this pass.
- **`MAX_OBJECTS_PER_RUN` (500) bounds each invocation** — a backlog larger than that is picked up across multiple scheduled ticks (never silently dropped), not completed in a single run. Matches Vercel's own serverless execution-time constraints.
- **Interactive UI click-through was not verified live in this pass** — the production build compiles cleanly and the view follows the codebase's established component conventions exactly, but a full authenticated walkthrough in a browser was not completed in this development session.
- **Vercel's exact clone behavior for the sibling `inaya-migration-agent` package is assumed, not directly observed** — based on Vercel's documented default (full git repository clone), verified locally via a successful `npm install` + `npm run build`, but not confirmed against the live deployment's own project settings from this environment.
