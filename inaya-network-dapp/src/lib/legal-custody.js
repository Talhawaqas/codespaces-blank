// src/lib/legal-custody.js
//
// Healthcare & Legal Expansion SOW, Phase 7 (§11.12) — chain of custody.
// No parallel audit system: every custody event is appendAuditEntry()
// with recordType "EVIDENCE", exactly like every other domain's audit
// wrapper in this SOW. legal_chain_events is a denser, evidence-scoped
// read-model on top of the chain (mirrors health-audit.js's
// health_access_events pattern) for a fast "show me this evidence's full
// custody history" query without walking the whole org chain.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { appendAuditEntry } from "./auditChain.js";

export const CUSTODY_ACTIONS = ["ACQUIRED", "UPLOADED", "VERIFIED", "TRANSFERRED", "ACCESSED", "COPIED", "EXPORTED", "RETURNED", "DISPOSITIONED"];

export async function recordCustodyEvent({ orgId, evidenceId, action, actorEmail, source, destination, hash, reason }) {
  if (!CUSTODY_ACTIONS.includes(action)) throw new Error(`Unknown custody action "${action}".`);
  const { legalChainEvents } = await getOrgCollections();
  const now = new Date().toISOString();
  const event = { orgId: toObjectId(orgId), evidenceId: toObjectId(evidenceId), action, actorEmail, source: source || null, destination: destination || null, hash: hash || null, reason: reason || null, timestamp: now };
  await legalChainEvents.insertOne(event);
  // Best-effort — see activity-log.js/org-activity-log.js: the real
  // custody event above already committed and must never be blocked by
  // the additive hash-chain layer.
  try {
    await appendAuditEntry({ orgId, recordType: "EVIDENCE", recordId: toObjectId(evidenceId), actorEmail, action, previousState: null, newState: null, metadata: { source, destination, hash, reason } });
  } catch (err) {
    console.error("legal-custody: audit chain append failed:", err.message);
  }
  return event;
}

export async function listCustodyEvents(orgId, evidenceId) {
  const { legalChainEvents } = await getOrgCollections();
  return legalChainEvents.find({ orgId: toObjectId(orgId), evidenceId: toObjectId(evidenceId) }).sort({ timestamp: 1 }).toArray();
}
