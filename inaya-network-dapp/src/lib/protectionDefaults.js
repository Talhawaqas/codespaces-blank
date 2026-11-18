// src/lib/protectionDefaults.js -- ransomware protection that every Business Workspace company gets without setting
// anything up (founder decision, 17 Nov 2026):
//   - every NEW S3-compatible bucket starts with versioning ON, plus a lifecycle rule that removes old versions after
//     NONCURRENT_VERSION_DAYS, so an overwrite or delete can always be rolled back for that long without storage
//     growing for ever;
//   - every NEW NAS share starts with a daily snapshot schedule: one snapshot a day, the last 14 kept, each immutable
//     (cannot be deleted, even with stolen credentials) for 7 days.
// Existing buckets and shares are not changed. A company can change or switch off either per bucket / per share.
// S3_DEFAULT_VERSIONING=off and NAS_DEFAULT_SNAPSHOTS=off switch the defaults off (the test harness does this for
// suites written for plain S3 semantics; test/protection-defaults.test.mjs exercises the defaults explicitly).

const isOff = (v) => ["0", "off", "false", "no"].includes(String(v ?? "").trim().toLowerCase());

export const NONCURRENT_VERSION_DAYS = 30;
export const DEFAULT_LIFECYCLE_RULE_ID = "inaya-default-keep-old-versions-30-days";
export const DEFAULT_NAS_SNAPSHOT_POLICY = { intervalMinutes: 1440, keepLast: 14, immutable: true, retentionDays: 7 };

export const s3DefaultVersioning = () => !isOff(process.env.S3_DEFAULT_VERSIONING);
export const nasDefaultSnapshots = () => !isOff(process.env.NAS_DEFAULT_SNAPSHOTS);
