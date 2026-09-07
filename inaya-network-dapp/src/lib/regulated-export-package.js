// src/lib/regulated-export-package.js
//
// Financial Services & Regulated Enterprise SOW, Phase 10 (§218) —
// Regulated Export Package. export-center.js's own header is explicit
// that "the actual package generation ... is intentionally left to each
// call site" — this IS that call site for the one packaging shape §218
// specifically defines: manifest, hashes, timestamps, source, version,
// authorization, chain verification result. It sits on top of
// export-center.js's existing request/approval workflow rather than
// forking a parallel one — a request must already be APPROVED (single-
// or dual-control, whichever export-center.js's own rules required)
// before a package can be generated here.
//
// The package's `records` snapshot and computed `hash` are stored
// together and immutable once created (no update function exists) — the
// same "self-service verifiable" property the audit hash chain already
// has. verifyRegulatedExportPackage() recomputes the hash from the stored
// manifest+records and reports drift, never assuming stored data is
// still what it was hashed from.
//
// No real file (ZIP/PDF) is produced -- this codebase has no file-
// bundling pipeline for the many different record shapes this could
// cover across financial/regulated data. The "package" is the manifest +
// hashed record snapshot + chain verification result itself, retrievable
// and independently re-verifiable via the API — an honest boundary, not
// a placeholder pretending to be a download.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageOrg } from "./orgGates.js";
import { verifyChainIntegrity } from "./auditChain.js";
import { logOrgActivity } from "./org-activity-log.js";
import { markExportGenerated } from "./export-center.js";

const PACKAGE_FORMAT_VERSION = "1.0";

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(",")}}`;
}

function computeHash(manifest, records) {
  return createHash("sha256").update(canonicalStringify({ manifest, records })).digest("hex");
}

/** Generates the package for an already-APPROVED export request. Only an
 *  org owner/admin can do this — matches export-center.js's own approval
 *  authority, since generating the package is the point where approved
 *  intent becomes a real, hashed evidentiary artifact. `records` is
 *  whatever snapshot the caller has already legitimately fetched for the
 *  request's scope — this function never queries other collections
 *  itself, so it can never accidentally include data outside what was
 *  actually requested and approved. */
export async function generateRegulatedExportPackage({ orgId, requestId, recordType, records, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can generate a regulated export package.", status: 403 };
  if (!Array.isArray(records) || records.length === 0) return { error: "records must be a non-empty array.", status: 400 };

  const { exportRequests, regulatedExportPackages } = await getOrgCollections();
  const request = await exportRequests.findOne({ _id: toObjectId(requestId), orgId: toObjectId(orgId) });
  if (!request) return { error: "Export request not found.", status: 404 };
  if (request.status !== "APPROVED") return { error: `The export request must be APPROVED before a package can be generated (it is currently ${request.status}).`, status: 409 };

  const chainVerificationResult = await verifyChainIntegrity(orgId);
  const now = new Date().toISOString();
  const manifest = {
    source: "Inaya Sovereign Enterprise OS",
    version: PACKAGE_FORMAT_VERSION,
    orgId: orgId.toString(),
    requestId: request._id.toString(),
    recordType,
    recordCount: records.length,
    generatedAt: now,
    generatedByEmail: actorEmail,
  };
  const authorization = {
    requestedByEmail: request.requestedByEmail,
    approvedByEmail: request.approvedByEmail,
    secondApproverEmail: request.secondApproverEmail || null,
    requiresDualControl: !!request.requiresDualControl,
  };
  const hash = computeHash(manifest, records);

  const doc = {
    orgId: toObjectId(orgId), requestId: request._id,
    manifest, records, hash, chainVerificationResult, authorization,
    createdAt: now,
  };
  const result = await regulatedExportPackages.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  const markResult = await markExportGenerated({ orgId, requestId, packageUrl: `/api/orgs/regulated-export-packages/${inserted._id}`, actorEmail });
  if (markResult.error) return markResult;

  await logOrgActivity({ orgId, recordType: "REGULATED_EXPORT_PACKAGE", recordId: inserted._id, actorEmail, action: "GENERATED", previousState: null, newState: null, metadata: { requestId: requestId.toString(), recordType, recordCount: records.length } });
  return { package: inserted };
}

/** Recomputes the hash from the stored manifest+records and reports
 *  whether it still matches -- never trusts the stored `hash` field on
 *  its own as proof of integrity. */
export async function verifyRegulatedExportPackage(orgId, packageId) {
  const { regulatedExportPackages } = await getOrgCollections();
  const pkg = await regulatedExportPackages.findOne({ _id: toObjectId(packageId), orgId: toObjectId(orgId) });
  if (!pkg) return { error: "Package not found.", status: 404 };
  const recomputedHash = computeHash(pkg.manifest, pkg.records);
  return { valid: recomputedHash === pkg.hash, storedHash: pkg.hash, recomputedHash, package: pkg };
}

export async function getRegulatedExportPackage(orgId, packageId) {
  const { regulatedExportPackages } = await getOrgCollections();
  return regulatedExportPackages.findOne({ _id: toObjectId(packageId), orgId: toObjectId(orgId) });
}

export async function listRegulatedExportPackages(orgId, { requestId } = {}) {
  const { regulatedExportPackages } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (requestId) query.requestId = toObjectId(requestId);
  return regulatedExportPackages.find(query).sort({ createdAt: -1 }).toArray();
}
