# Runbook: ransomware signals and recovery (cloud files)

Applies to files reached through the storage API (S3/Azure-compatible layer, DirectSync, Drive) with `FEATURE_RANSOMWARE_SIGNALS` on. The NAS appliance has its own, separate ransomware controls.

## What the system does

* Scores each credential's file activity for mass overwrites and deletes, encryption-like rewrites (entropy jumps), known ransomware extensions, ransom-note names and a hidden tripwire folder (`.inaya-canary/`). Each signal records the **rule that fired and its confidence**. A signal is a heuristic, **not proof** of an attack.
* On a high-confidence signal it can **contain** the credential: writes and deletes from it are refused (`Contained`) while reads continue. Containment is per credential, so one compromised key does not stop everyone.
* It plans a **rollback** from object versions: for each affected object, the last version before the activity began.

## When you see a signal

1. Open **Ransomware Signals**. Read the rules and confidence, the credential, the first and last activity times, and the sample of affected objects.
2. **Decide whether it is real.** Typical false positives: a bulk compression or re-encryption job you started, a migration, a backup that rewrites files. Ask the credential's owner.
3. **If it is not real:** mark the signal as a false positive. Lift containment if it was applied.
4. **If it might be real:** keep containment on, then:
   1. Revoke the credential (S3 credentials, API key or device) so it cannot come back.
   2. Sign the affected person out and require a password change and MFA re-enrollment.
   3. Review the audit trail for what else that identity did.
   4. Preview the **rollback plan**. It lists what would be restored and what cannot be (objects without an earlier version).
   5. Approve the rollback. It restores versions through the same versioned-storage operation used for ordinary restores; legal-hold and Object Lock rules still apply.
   6. Confirm a sample of restored files by opening them.
5. Notify your security contact. If personal data may be affected, follow your breach-notification obligations.

## What it cannot do

* It does not see activity on endpoints; it sees file operations that reach Inaya. Encrypted-at-the-endpoint ransomware that never writes through the API is invisible here.
* It cannot restore objects that were never versioned, or versions older than your retention allows.
* It cannot tell a malicious bulk rewrite from a legitimate one by itself. A person decides.

## Prevention checklist

* Turn on versioning and, where required, Object Lock and legal hold for important buckets.
* Give each integration its own scoped credential (bucket, prefix, operations, expiry).
* Keep endpoint backups (Endpoint Backup) with ransomware-safe restore enabled.
* Test a rollback on a non-critical bucket once, so the first time is not the incident.
* Recovery testing and a replica at a second provider are in Settings, Site replication.
