# Business Workspace Hero — Claims Verification (17 Nov 2026)

Brief: *Claude Code Verification & Hero Update Brief* + *Hero Line Options (Ransomware & Security Focus)*. Every claim on the `/business` hero was checked against the code and tests before it was published.

## Copy used (Option 1, two phrases changed to avoid guarantees)
- Badge: **NEW: TESTED IMMUTABLE SNAPSHOTS & RANSOMWARE ROLLBACK**
- H1: **Run Your Entire Business on Sovereign, Ransomware-Resilient Infrastructure.**
- Sub-headline: *One workspace for 77 business modules, from finance, HR and CRM to inventory and documents, with documents encrypted on your own device, immutable snapshots and tested ransomware rollback, so you can restore your data instead of paying a ransom.*
- Trust strip: *Encrypted chunked storage · Immutable snapshots & point-in-time rollback · Automated nightly backups*

Changed from the option text: "client-side encryption" → "documents encrypted on your own device" (S3/NAS files are encrypted by the server, not the device); "so your company data is never held hostage" → "so you can restore your data instead of paying a ransom" ("never" is a guarantee no product can give).

## Evidence
| Claim | Where it lives | Proof | Production state |
|---|---|---|---|
| 77 business modules | `src/lib/navigation/navItems.js` | SQA crawl of all 77 modules (desktop + phone) | Live |
| Documents encrypted on your own device | `src/lib/clientCrypto.js`, `src/lib/chunkedFile.js` | chunked-file tests (round trip, tamper, wrong passkey) | Live |
| Encrypted chunked storage | `src/lib/chunkedFile.js` (AES-256-GCM, 16 MiB pieces), `src/lib/chunkedStorage.js` | `test/chunked-file.test.mjs`, `test/s3-chunked-format.test.mjs` (incl. live Filebase) | Live (Filebase primary, Pinata fallback) |
| Immutable snapshots | NAS: `src/lib/nas/snapshots.js` (immutable + retention lock), S3: Object Lock / legal hold in `src/lib/s3-compat/store.js` | `nas-realclient` (snapshots resist deletion), `nas-protection` 47/47, S3 object-lock tests | Live; **on by default for new NAS shares since 17 Nov** (daily, 14 kept, immutable 7 days) |
| Point-in-time rollback | NAS snapshot restore (side-by-side or in place with a reason); S3 version restore; cloud ransomware rollback (`src/lib/ransomware/cloud.js`) | `nas-protection` "recovery: the last CLEAN snapshot restores the originals", `test/protection-defaults.test.mjs` (overwrite rolled back) | Live; **versioning on by default for new buckets since 17 Nov** (old versions kept 30 days) |
| Tested ransomware rollback | NAS: `src/lib/nas/ransomware.js` (detect → lockdown → restore last clean snapshot); cloud: `src/lib/ransomware/cloud.js` | `nas-protection` ransomware response + recovery tests; cloud ransomware tests | NAS live; **cloud signals switched on in production (FEATURE_RANSOMWARE_SIGNALS=on, 17 Nov) — effective from the next deploy** |
| Automated nightly backups | `src/lib/dbBackup.js`, `/api/cron/db-backup` at 02:30 UTC (`vercel.json`), encrypted, 14 kept | SQA: 17 Nov backup present (489 collections, 102,993 records, 272 companies) and decrypted | Live |

## Notes
- Founder decision (17 Nov): the older sentence "Every file is encrypted on your own device before it is uploaded" (hero paragraph and the page's structured-data description) was removed: it is true for Documents but not for S3/NAS files, which the server encrypts.
- NAS schedules (snapshots, ransomware scans, replication) run in the NAS worker on the customer's host next to the appliance (`scripts/nas-worker.mjs`), by design: the hosted site cannot reach a NAS on a customer network. `/api/cron/nas` is intentionally not in `vercel.json`.
- Snapshots and versions only protect data stored after they were switched on; the new defaults make that automatic for every new bucket and share. Existing buckets/shares keep their own settings.
- CSP: the hero adds no scripts or external assets (text and Tailwind classes only).
