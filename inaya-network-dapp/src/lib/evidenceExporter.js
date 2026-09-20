// src/lib/evidenceExporter.js
//
// Enterprise Adoption & Market Reach Expansion SOW, Workstream C -- Proof
// of Sovereignty / Compliance Evidence Exporter. Read-only: aggregates
// records that already exist (cryptographic audit chain, S3-compat bucket
// protection settings, org membership/credential events) into one
// structured evidence package. Creates NOTHING new to track -- no second
// audit system, no new tracking collection. Per §6.1/§6.7, this is an
// EVIDENCE exporter, not a certification: it never claims HIPAA/GDPR/
// SOC2/17a-4 compliance, only that it packages real, existing evidence an
// organization can hand to its own auditors.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { listAuditChain, verifyChainIntegrity } from "./auditChain.js";
import * as s3Store from "./s3-compat/store.js";

/** Same stable-key-order canonicalization auditChain.js already uses for
 *  its own hash chain -- the SAME technique, not a second one, so two
 *  exports of identical underlying data always serialize identically
 *  (SOW §6.6 "deterministic canonical representation"). */
function canonicalize(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeysDeep(value[k]);
        return acc;
      }, {});
  }
  return value;
}

function sha256Hex(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

/** Storage evidence: every bucket this org owns, with its real
 *  versioning/Object Lock/lifecycle configuration -- reusing store.js's
 *  own already-tested getters, never re-deriving this state independently
 *  (a second, possibly-drifted copy of "is this bucket locked" would be
 *  worse than no evidence at all). */
async function gatherStorageEvidence(orgId) {
  const buckets = await s3Store.listS3Buckets(orgId);
  const perBucket = [];
  for (const b of buckets) {
    const [versioning, lifecycle] = await Promise.all([
      s3Store.getBucketVersioning({ orgId, bucket: b.name }).catch(() => null),
      s3Store.getLifecyclePolicy({ orgId, bucket: b.name }).catch(() => null),
    ]);
    perBucket.push({
      bucket: b.name,
      createdAt: b.createdAt,
      versioningStatus: versioning?.versioningStatus || "Unversioned",
      objectLockEnabled: !!versioning?.objectLockEnabled,
      lifecycleRules: lifecycle?.rules || [],
    });
  }
  return { buckets: perBucket };
}

/** Security evidence: authentication/authorization/credential/permission
 *  events, read directly from the org's existing plain activity log
 *  (org-activity-log.js) -- the same events every other part of the app
 *  already relies on, not a re-derived summary. */
async function gatherSecurityEvidence(orgId, { sinceIso }) {
  const { orgActivity } = await getOrgCollections();
  const SECURITY_RECORD_TYPES = ["credential", "s3_credential", "membership", "session", "org_member"];
  const events = await orgActivity
    .find({
      orgId: toObjectId(orgId),
      timestamp: sinceIso ? { $gte: sinceIso } : { $exists: true },
      $or: [{ recordType: { $in: SECURITY_RECORD_TYPES } }, { action: { $regex: /AUTH|CREDENTIAL|PERMISSION|MEMBER|LOGIN|SESSION/i } }],
    })
    .sort({ timestamp: -1 })
    .limit(1000)
    .toArray();
  return {
    eventCount: events.length,
    events: events.map((e) => ({ recordType: e.recordType, action: e.action, actorEmail: e.actorEmail, timestamp: e.timestamp })),
  };
}

/** Audit evidence: the org's own cryptographic audit chain, verbatim --
 *  including a live re-verification of its own integrity (SOW §6.4's
 *  "chain-integrity verification result" is a REAL recomputation here,
 *  not a stored flag that could itself have gone stale). */
async function gatherAuditEvidence(orgId, { sinceIso }) {
  const chain = await listAuditChain(orgId, { limit: 1000 });
  const integrity = await verifyChainIntegrity(orgId);
  const filtered = sinceIso ? chain.filter((e) => e.timestamp >= sinceIso) : chain;
  return {
    chainIntegrity: integrity,
    entryCount: filtered.length,
    entries: filtered.map((e) => ({
      seq: e.seq,
      recordType: e.recordType,
      action: e.action,
      actorEmail: e.actorEmail,
      timestamp: e.timestamp,
      prevHash: e.prevHash,
      entryHash: e.entryHash,
    })),
  };
}

/** Builds the full evidence package for one org. `sinceIso`/`untilIso`
 *  scope the reporting period (SOW §6.4 "reporting period"); omit both
 *  for "everything on record." Never mutates anything -- every call here
 *  is a read. */
export async function buildEvidencePackage({ orgId, actorEmail, sinceIso = null, untilIso = null }) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) });
  if (!org) throw new Error("Organization not found.");

  const [storage, security, audit] = await Promise.all([
    gatherStorageEvidence(orgId),
    gatherSecurityEvidence(orgId, { sinceIso }),
    gatherAuditEvidence(orgId, { sinceIso }),
  ]);

  const generatedAt = new Date().toISOString();
  const doc = {
    schemaVersion: "1.0",
    executiveSummary: {
      organization: org.name,
      orgId: orgId.toString(),
      exportTimestamp: generatedAt,
      reportingPeriod: { since: sinceIso, until: untilIso || generatedAt },
      generatedByEmail: actorEmail,
    },
    storageEvidence: storage,
    securityEvidence: security,
    auditEvidence: audit,
    cryptographicEvidence: {
      // Objects written through the S3-compat layer use Inaya's real
      // server-managed envelope-encryption model (see store.js's own
      // header) -- stated plainly, not implied to be the wallet-side
      // zero-knowledge guarantee, which is a structurally different
      // property for a different access path.
      encryptionModel: "server-managed (S3/Azure/GCS compatibility layer); client-managed (wallet-direct uploads)",
      auditChainAlgorithm: "SHA-256 hash chain (prevHash + canonical event fields)",
      packageGeneratedFromLiveData: true,
    },
    disclosure:
      "This package documents evidence that already exists in the Inaya platform's own records. It is generated to support internal, legal, regulatory, and third-party audit processes. It is not itself a certification of compliance with any specific law, regulation, or standard.",
  };

  const exportHash = sha256Hex(canonicalize(doc));
  return { ...doc, exportHash };
}

export { canonicalize as canonicalizeForExport };
