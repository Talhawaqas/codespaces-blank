// src/lib/workflows/memory.js
//
// SOW §16: the reference design has an "Agent Memory" component. Inaya had no
// agent memory (the assistants' chat history is per request), so this is a
// genuine gap. It is deliberately small and conservative:
//   - every row is keyed by orgId + workflowId (+ version + execution), and every
//     read filters on both, so memory cannot leak between organizations or workflows;
//   - what is stored is the agent's compact conclusion (summary, classification,
//     a few headline numbers), never raw business records; PII in the text is
//     redacted before it is written, and each row carries a sensitivity label;
//   - rows expire (TTL index on expiresAt) per the workflow's retention setting.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { redactPII } from "../aiSecurity/piiDetector.js";

export async function readMemory({ orgId, workflowId, limit = 3 }) {
  const { workflowMemory } = await getOrgCollections();
  const rows = await workflowMemory.find({ orgId: toObjectId(orgId), workflowId: toObjectId(workflowId), expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(Math.min(limit, 10)).toArray();
  return rows.map((r) => ({ at: r.createdAt, source: r.source, sensitivity: r.sensitivity, content: r.content })).reverse();
}

export async function writeMemory({ orgId, workflowId, workflowVersion, executionId, source = "ai.agent", content, retentionDays = 30 }) {
  const { workflowMemory } = await getOrgCollections();
  const red = redactPII(String(content || "").slice(0, 1500));
  const now = new Date();
  const doc = {
    orgId: toObjectId(orgId), workflowId: toObjectId(workflowId), workflowVersion, executionId: executionId ? toObjectId(executionId) : null,
    source, content: red.text, sensitivity: red.wasRedacted ? "contained_pii_redacted" : "internal",
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + Math.max(1, Math.min(retentionDays, 365)) * 86400000),
  };
  const r = await workflowMemory.insertOne(doc);
  return { memoryId: String(r.insertedId), sensitivity: doc.sensitivity };
}

export async function clearMemory({ orgId, workflowId }) {
  const { workflowMemory } = await getOrgCollections();
  const r = await workflowMemory.deleteMany({ orgId: toObjectId(orgId), workflowId: toObjectId(workflowId) });
  return { deleted: r.deletedCount };
}
