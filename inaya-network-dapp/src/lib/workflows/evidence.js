// src/lib/workflows/evidence.js
//
// SOW §27, §46, §47, §68: workflow evidence. NOT a second audit universe (it
// mirrors nas/evidence.js, which itself follows the Document Automation SOW):
//
//   1. Every lifecycle/node event is written through logOrgActivity -> the
//      organization's existing hash-chained audit trail (`audit_chain_entries`).
//   2. The audit entry's metadata carries `evidenceHash`, the canonical hash of
//      the evidence row, so the chain itself commits to what the row said. A row
//      edited later no longer matches its audit entry; a forged row has no audit
//      entry at all (verifyWorkflowEvidence catches both).
//   3. For production runs the execution is an Evidence Graph subject
//      (WORKFLOW_EXECUTION) and the meaningful steps -- data read, KPI, AI
//      analysis, decision, approval, action, notification, simulation -- are typed
//      relationships on it, so the existing timeline / passport / explain views
//      show the run.
//
// Evidence stores ids, hashes, counts, decisions and structured AI output. It
// never stores hidden model reasoning, secrets or raw business records.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { verifyChainIntegrity } from "../auditChain.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { canonicalHash } from "../documentAutomation/manifest.js";
import { SYNTHETIC_OWNER, WORKFLOW_EVENTS, redact, bounded } from "./common.js";

const GRAPH_RELATIONSHIP = {
  DATA_READ: "SOURCED_FROM", KPI_SNAPSHOT: "DERIVED_FROM", AI_ANALYSIS: "ANALYZED_BY", DECISION_MADE: "CHECKED_BY",
  APPROVAL_REQUESTED: "REQUIRES", APPROVAL_RESOLVED: "APPROVED_BY", ACTION_EXECUTED: "EXECUTED_AS", NOTIFICATION_SENT: "PROVEN_BY",
  SIMULATION_LINKED: "REFERENCES", REPORT_GENERATED: "DERIVED_FROM", EXECUTION_COMPLETED: "PROVEN_BY",
};
export const EVIDENCE_KINDS = [...new Set([...WORKFLOW_EVENTS, ...Object.keys(GRAPH_RELATIONSHIP), "TRIGGERED", "AI_EVIDENCE_NOTE", "AI_TOOL_CALLED"])];

function rowFingerprint(row) {
  const { _id, rowHash, auditRef, ...content } = row;
  return canonicalHash(content);
}

/**
 * Records one evidence event. Never throws: the operation already happened, so
 * a recording failure is returned as { ok:false } and logged, never allowed to
 * undo or hide the operation.
 */
export async function recordWorkflowEvidence({ orgId, workflowId = null, executionId = null, action, nodeKey = null, mode = "production", result = "OK", actorEmail = "system", actorType = "system", data = {}, graph = true, secrets = [] }) {
  try {
    if (!EVIDENCE_KINDS.includes(action)) return { ok: false, error: `Unknown workflow evidence kind ${action}` };
    const { workflowEvidence } = await getOrgCollections();
    const row = {
      orgId: toObjectId(orgId), workflowId: workflowId ? toObjectId(workflowId) : null, executionId: executionId ? toObjectId(executionId) : null,
      action, nodeKey, mode, result, actor: { email: actorEmail, type: actorType },
      data: bounded(redact(data, { secrets }), 60_000), createdAt: new Date().toISOString(),
    };
    row.rowHash = rowFingerprint(row);
    const inserted = await workflowEvidence.insertOne(row);
    const subjectId = executionId || workflowId;
    const event = await logOrgActivity({
      orgId, recordType: executionId ? "WORKFLOW_EXECUTION" : "WORKFLOW", recordId: subjectId || orgId, actorEmail, action: WORKFLOW_EVENTS.includes(action) ? action : `EVIDENCE_${action}`,
      previousState: null, newState: result,
      metadata: { evidenceId: String(inserted.insertedId), evidenceHash: row.rowHash, workflowId: workflowId ? String(workflowId) : null, executionId: executionId ? String(executionId) : null, nodeKey, mode, result, evidenceKind: action },
    });
    if (event.auditChain) await workflowEvidence.updateOne({ _id: inserted.insertedId }, { $set: { auditRef: event.auditChain } });
    let graphResult = null;
    if (graph && mode === "production" && executionId && GRAPH_RELATIONSHIP[action]) {
      // graph:"defer" lets the engine batch every relationship of a run into ONE Evidence Graph write
      graphResult = graph === "defer"
        ? { deferred: true, type: GRAPH_RELATIONSHIP[action] }
        : await linkExecutionGraph({ orgId, executionId, evidenceId: inserted.insertedId, type: GRAPH_RELATIONSHIP[action], note: `${action}${nodeKey ? " @" + nodeKey : ""}` });
    }
    return { ok: true, evidenceId: String(inserted.insertedId), rowHash: row.rowHash, auditRef: event.auditChain || null, graph: graphResult };
  } catch (err) {
    console.error("recordWorkflowEvidence failed (non-fatal):", err.message);
    return { ok: false, error: err.message };
  }
}

/** Ensures the execution is an Evidence Graph subject and adds a typed relationship. */
export async function linkExecutionGraph({ orgId, executionId, evidenceId, type, note }) {
  try {
    const { businessEvents } = await getOrgCollections();
    let event = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "WORKFLOW_EXECUTION", subjectId: toObjectId(executionId), deletedAt: null });
    if (!event) {
      const created = await createBusinessEvent({ orgId, subjectType: "WORKFLOW_EXECUTION", subjectId: String(executionId), membership: SYNTHETIC_OWNER, actorEmail: "system", relationships: [] });
      if (created.error) return { ok: false, error: created.error };
      event = created.event;
    }
    await addBusinessEventRelationship({ orgId, eventId: String(event._id), membership: SYNTHETIC_OWNER, actorEmail: "system", type, targetType: "WORKFLOW_EVIDENCE", targetId: String(evidenceId), note });
    return { ok: true, eventId: String(event._id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** One Evidence Graph write for a whole run: creates the execution subject with every relationship at once. */
export async function linkExecutionGraphBatch({ orgId, executionId, items }) {
  if (!items?.length) return { ok: true, linked: 0 };
  try {
    const { businessEvents } = await getOrgCollections();
    const existing = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "WORKFLOW_EXECUTION", subjectId: toObjectId(executionId), deletedAt: null });
    if (!existing) {
      const rels = items.map((i) => ({ type: i.type, targetType: "WORKFLOW_EVIDENCE", targetId: i.evidenceId, note: i.note }));
      const created = await createBusinessEvent({ orgId, subjectType: "WORKFLOW_EXECUTION", subjectId: String(executionId), membership: SYNTHETIC_OWNER, actorEmail: "system", relationships: rels });
      return created.error ? { ok: false, error: created.error } : { ok: true, linked: items.length, eventId: String(created.event._id) };
    }
    for (const i of items) await addBusinessEventRelationship({ orgId, eventId: String(existing._id), membership: SYNTHETIC_OWNER, actorEmail: "system", type: i.type, targetType: "WORKFLOW_EVIDENCE", targetId: i.evidenceId, note: i.note });
    return { ok: true, linked: items.length, eventId: String(existing._id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function listWorkflowEvidence({ orgId, executionId, workflowId, limit = 500 }) {
  const { workflowEvidence } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (executionId) q.executionId = toObjectId(executionId);
  if (workflowId) q.workflowId = toObjectId(workflowId);
  return workflowEvidence.find(q).sort({ createdAt: 1 }).limit(Math.min(limit, 1000)).toArray();
}

/**
 * Independently verifies workflow evidence: each row still hashes to its rowHash;
 * the audit-chain entry it references exists, matches, and committed the same
 * evidenceHash; and the whole audit chain is intact.
 */
export async function verifyWorkflowEvidence({ orgId, executionId, workflowId, limit = 1000 }) {
  const { workflowEvidence, auditChainEntries } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (executionId) q.executionId = toObjectId(executionId);
  if (workflowId) q.workflowId = toObjectId(workflowId);
  const rows = await workflowEvidence.find(q).sort({ createdAt: 1 }).limit(limit).toArray();
  const problems = [];
  for (const row of rows) {
    if (rowFingerprint(row) !== row.rowHash) { problems.push({ evidenceId: String(row._id), problem: "ROW_ALTERED", action: row.action }); continue; }
    if (!row.auditRef) { problems.push({ evidenceId: String(row._id), problem: "NO_AUDIT_ENTRY", action: row.action }); continue; }
    const entry = await auditChainEntries.findOne({ orgId: row.orgId, seq: row.auditRef.seq });
    if (!entry || entry.entryHash !== row.auditRef.entryHash) { problems.push({ evidenceId: String(row._id), problem: "AUDIT_ENTRY_MISSING_OR_ALTERED", action: row.action }); continue; }
    if (entry.metadata?.evidenceHash !== row.rowHash) problems.push({ evidenceId: String(row._id), problem: "AUDIT_ENTRY_DOES_NOT_MATCH_ROW", action: row.action });
  }
  const chain = await verifyChainIntegrity(orgId).catch((e) => ({ valid: false, reason: e.message }));
  return { verified: problems.length === 0 && chain.valid, rowsChecked: rows.length, problems, auditChain: { valid: chain.valid, entries: chain.count ?? null, reason: chain.reason || null } };
}

/**
 * SOW §47: the exportable Evidence Passport for one execution, assembled from
 * the execution record and the verified evidence rows. Carries its own hash and
 * the verification status at export time.
 */
export async function buildEvidencePassport({ orgId, executionId }) {
  const { workflowExecutions } = await getOrgCollections();
  const exec = await workflowExecutions.findOne({ _id: toObjectId(executionId), orgId: toObjectId(orgId) });
  if (!exec) return { error: "Execution not found.", status: 404 };
  const rows = await listWorkflowEvidence({ orgId, executionId });
  const verification = await verifyWorkflowEvidence({ orgId, executionId });
  const nr = exec.nodeResults || {};
  const pick = (pred) => Object.entries(nr).filter(([k, v]) => pred(k, v)).map(([k, v]) => ({ node: k, type: v.type, status: v.status, at: v.completedAt, summary: v.outputSummary }));
  const kpiNode = Object.entries(nr).find(([, v]) => v.type === "kpi.snapshot");
  const aiNode = Object.entries(nr).find(([, v]) => v.type === "ai.agent");
  const conditions = Object.entries(nr).filter(([, v]) => v.type === "condition.if");
  const passport = {
    passportVersion: "1", generatedAt: new Date().toISOString(),
    workflow: { workflowId: String(exec.workflowId), workflowName: exec.workflowName, workflowVersion: exec.workflowVersion, definitionHash: exec.definitionHash || null },
    execution: { executionId: String(exec._id), mode: exec.mode, status: exec.status, trigger: exec.trigger, initiatingIdentity: exec.initiatingIdentity, startedAt: exec.startedAt, completedAt: exec.completedAt },
    sourceReferences: pick((k, v) => v.type?.startsWith("data.") || v.type === "http.request"),
    kpiSnapshot: kpiNode ? kpiNode[1].output?.snapshot || null : null,
    aiStructuredOutput: aiNode ? aiNode[1].output?.result || null : null,
    aiExplainability: aiNode ? aiNode[1].output?.explainability || null : null,
    rulesEvaluated: conditions.map(([k, v]) => ({ node: k, expression: v.output?.expression, result: v.output?.result, branch: v.output?.branch })),
    branchSelected: exec.summary?.branch || null,
    approvals: pick((k, v) => v.type === "action.propose").map((a) => ({ ...a, approval: nr[a.node]?.output || null })),
    actions: rows.filter((r) => r.action === "ACTION_EXECUTED").map((r) => ({ at: r.createdAt, node: r.nodeKey, data: r.data })),
    notifications: rows.filter((r) => r.action === "NOTIFICATION_SENT").map((r) => ({ at: r.createdAt, node: r.nodeKey, data: r.data })),
    evidenceRows: rows.map((r) => ({ evidenceId: String(r._id), action: r.action, node: r.nodeKey, result: r.result, at: r.createdAt, rowHash: r.rowHash, auditRef: r.auditRef || null })),
    cryptographicAuditReferences: rows.filter((r) => r.auditRef).map((r) => r.auditRef),
    verification: { verified: verification.verified, rowsChecked: verification.rowsChecked, problems: verification.problems, auditChainValid: verification.auditChain.valid },
    note: "Hidden model reasoning is never recorded; the AI section is the structured answer, tool-call log, inputs and thresholds only.",
  };
  passport.passportHash = canonicalHash(passport);
  return { passport };
}
