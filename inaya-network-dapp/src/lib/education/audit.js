// src/lib/education/audit.js
//
// Education OS audit: one helper that appends to the org's tamper-evident
// hash chain (auditChain.js). Same resilience rule as government-audit.js:
// a chain failure never fails the action that already committed.

import { appendAuditEntry } from "../auditChain.js";
import { toObjectId } from "../orgs.js";

export async function logEducationEvent({ orgId, recordType, recordId, actorEmail, action, metadata }) {
  try {
    await appendAuditEntry({ orgId, recordType, recordId: recordId ? toObjectId(recordId) : null, actorEmail, action, previousState: null, newState: null, metadata: metadata || {} });
  } catch (err) {
    console.error("education-audit: audit chain append failed:", err.message);
  }
}
