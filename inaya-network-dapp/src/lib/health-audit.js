// src/lib/health-audit.js
//
// Healthcare & Legal Expansion SOW, Phase 3 (§10.21) — the health-domain
// equivalent of activity-log.js/org-activity-log.js: writes the real,
// human-readable record FIRST (health_access_events — a denser,
// patient-scoped read-model the Patient 360 view needs fast, without
// walking the whole org's audit chain), then best-effort appends to the
// hash-chain SECOND. Same resilience discipline as those two files: a
// chain-append failure (e.g. transient write contention) must never
// block or fail a call whose real, human-readable record already
// committed successfully.

import { appendAuditEntry } from "./auditChain.js";
import { getOrgCollections, toObjectId } from "./orgs.js";

async function chainSafely(entry) {
  try {
    await appendAuditEntry(entry);
  } catch (err) {
    console.error("health-audit: audit chain append failed:", err.message);
  }
}

export async function logPatientAccess({ orgId, patientId, actorEmail, action, metadata }) {
  const { healthAccessEvents } = await getOrgCollections();
  const event = { orgId: toObjectId(orgId), patientId: toObjectId(patientId), actorEmail, action, timestamp: new Date().toISOString(), metadata: metadata || {} };
  await healthAccessEvents.insertOne(event);
  await chainSafely({ orgId, recordType: "PATIENT_RECORD", recordId: toObjectId(patientId), actorEmail, action, previousState: null, newState: null, metadata: metadata || {} });
  return event;
}

export async function logConsentChange({ orgId, patientId, actorEmail, action, metadata }) {
  // Consent changes are recorded via logPatientAccess so they appear in
  // the same per-patient access timeline the Patient 360 view reads —
  // a consent change IS a patient-record event, not a separate category.
  return logPatientAccess({ orgId, patientId, actorEmail, action, metadata });
}

export async function logBreakGlassGrant({ orgId, patientId, actorEmail, reason }) {
  return logPatientAccess({ orgId, patientId, actorEmail, action: "BREAK_GLASS_GRANTED", metadata: { reason } });
}

export async function listPatientAccessEvents(orgId, patientId) {
  const { healthAccessEvents } = await getOrgCollections();
  return healthAccessEvents.find({ orgId: toObjectId(orgId), patientId: toObjectId(patientId) }).sort({ timestamp: -1 }).toArray();
}
