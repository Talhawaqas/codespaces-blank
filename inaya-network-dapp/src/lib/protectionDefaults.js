// src/lib/protectionDefaults.js -- ransomware protection that every Business Workspace company gets without setting
// anything up (founder decision, 17 Nov 2026):
//   - every NEW S3-compatible bucket starts with versioning ON, plus a lifecycle rule that removes old versions after
//     NONCURRENT_VERSION_DAYS, so an overwrite or delete can always be rolled back for that long without storage
//     growing for ever;
//   - every NEW NAS share starts with a daily snapshot schedule: one snapshot a day, the last 14 kept, each immutable
//     (cannot be deleted, even with stolen credentials) for 7 days.
//   - every NEW NAS share also gets a nightly OFF-SITE backup to Inaya cloud storage (encrypted, verified, the last 14
//     recovery points kept), so a stolen, destroyed or failed appliance does not take the snapshots' only copy with it.
// Buckets and shares that existed before 17 Nov 2026 get the same protection once through scripts/ops/apply-protection-defaults.mjs
// (src/lib/protectionBackfill.js), which never overrides a choice the company made. A company can change or switch off any
// of these per bucket / per share.
// S3_DEFAULT_VERSIONING=off, NAS_DEFAULT_SNAPSHOTS=off and NAS_DEFAULT_OFFSITE_BACKUP=off switch the defaults off (the test harness does this for
// suites written for plain S3 semantics; test/protection-defaults.test.mjs exercises the defaults explicitly).

const isOff = (v) => ["0", "off", "false", "no"].includes(String(v ?? "").trim().toLowerCase());

export const NONCURRENT_VERSION_DAYS = 30;
export const DEFAULT_LIFECYCLE_RULE_ID = "inaya-default-keep-old-versions-30-days";
export const DEFAULT_NAS_SNAPSHOT_POLICY = { intervalMinutes: 1440, keepLast: 14, immutable: true, retentionDays: 7 };

export const DEFAULT_NAS_BACKUP_POLICY = { intervalMinutes: 1440, keepRecoveryPoints: 14, verify: "sample" };

export const s3DefaultVersioning = () => !isOff(process.env.S3_DEFAULT_VERSIONING);
export const nasDefaultSnapshots = () => !isOff(process.env.NAS_DEFAULT_SNAPSHOTS);
export const nasDefaultOffsiteBackup = () => !isOff(process.env.NAS_DEFAULT_OFFSITE_BACKUP);
