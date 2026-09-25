// src/lib/documentAutomation/evidence.js
//
// Document Automation SOW §12/§13/§14/§29 -- the provenance layer.
//
// Every material event on a document is recorded THREE ways, none of which
// is a second audit system:
//   1. logOrgActivity (org_activity + the org's real cryptographic audit
//      chain, auditChain.js) -- the tamper-evident record of WHEN, by WHOM.
//   2. An evidence NODE on the document itself, hash-linked to the previous
//      node (prevNodeHash -> nodeHash). Its head is the manifest's
//      `evidenceRoot`, so a document can prove its own chain without
//      trusting a query; each node also carries the audit-chain entry hash
//      that recorded it (`auditRef`), tying the two together.
//   3. The Evidence Graph: the document is a Business Event subject, with
//      typed relationships to its source records, previous version and
//      approval -- so the existing timeline/passport/explain views see it.
//
// Node types follow §12's minimum chain: SOURCE_SELECTED, SOURCE_SNAPSHOT,
// CALCULATION, TEMPLATE_VERSION, DOCUMENT_GENERATED, VALIDATION_COMPLETED,
// APPROVAL_REQUESTED, APPROVAL_GRANTED/REJECTED, DOCUMENT_FINALIZED,
// STORAGE_COMPLETED, SECURE_LINK_CREATED, DOCUMENT_ACCESSED/DOWNLOADED,
// SECURE_LINK_REVOKED, DOCUMENT_SUPERSEDED/VOIDED/CANCELLED, and so on.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createBusinessEvent, addBusinessEventRelationship } from "../businessEvents.js";
import { canonicalHash, canonicalStringify } from "./manifest.js";

export const GENESIS = "0".repeat(64);
const MAX_ATTEMPTS = 8;
const MAX_NODES = 500;

export const ACTOR_TYPES = ["human", "ai", "system", "external"];

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function permissionContext(membership, gate) {
  return { role: membership?.role || null, financeRole: membership?.financeRole || null, gate: gate || null };
}

/**
 * Appends one evidence node. Safe under concurrency (optimistic append on
 * the document's evidence sequence) and never throws to the caller --
 * returns { ok, node } or { ok:false, error } so a failure is recorded as
 * EVIDENCE_PENDING (SOW §27) instead of corrupting the operation.
 */
export async function recordEvidence({
  orgId, documentId, nodeType, actorEmail, actorType = "human", membership, gate, data = {}, documentVersion, documentNumber, correlationId, logActivity = true, previousState = null, newState = null,
}) {
  const { generatedDocuments } = await getOrgCollections();
  const _id = toObjectId(documentId);
  const orgObjectId = toObjectId(orgId);
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const cur = await generatedDocuments.findOne({ _id, orgId: orgObjectId }, { projection: { evidenceHead: 1, evidenceSeq: 1, documentVersion: 1, documentNumber: 1, correlationId: 1 } });
      if (!cur) return { ok: false, error: "Document not found." };
      const seq = (cur.evidenceSeq || 0) + 1;
      if (seq > MAX_NODES) return { ok: false, error: "Evidence chain limit reached." };
      const prevNodeHash = cur.evidenceHead || GENESIS;
      const node = {
        seq, nodeType, at: new Date().toISOString(),
        actor: { email: actorEmail || null, type: ACTOR_TYPES.includes(actorType) ? actorType : "system" },
        permission: permissionContext(membership, gate),
        documentId: String(documentId), documentVersion: documentVersion ?? cur.documentVersion, documentNumber: documentNumber ?? cur.documentNumber ?? null,
        correlationId: correlationId || cur.correlationId || null,
        data, dataHash: canonicalHash(data), prevNodeHash,
      };
      node.nodeHash = sha(prevNodeHash + canonicalStringify(node));
      // First node: evidenceSeq is 0 (claim rows) or absent; later nodes must match the exact seq read above.
      const filter = { _id, orgId: orgObjectId, evidenceSeq: cur.evidenceSeq ? cur.evidenceSeq : { $in: [0, null] } };
      const pushed = await generatedDocuments.updateOne(filter, { $push: { evidenceNodes: node }, $set: { evidenceHead: node.nodeHash, evidenceSeq: seq, updatedAt: node.at } });
      if (pushed.modifiedCount !== 1) continue; // lost the race for this seq -- re-read and retry

      if (logActivity) {
        const event = await logOrgActivity({
          orgId, recordType: "GENERATED_DOCUMENT", recordId: _id, actorEmail: actorEmail || (actorType === "system" ? "system" : null),
          action: nodeType, previousState, newState,
          metadata: { evidenceSeq: seq, nodeHash: node.nodeHash, dataHash: node.dataHash, actorType: node.actor.type, documentVersion: node.documentVersion, documentNumber: node.documentNumber, ...safeMeta(data) },
        }).catch((err) => { console.error("recordEvidence: activity log failed (non-fatal):", err.message); return null; });
        if (event?.auditChain) {
          await generatedDocuments.updateOne({ _id }, { $set: { "evidenceNodes.$[n].auditRef": event.auditChain } }, { arrayFilters: [{ "n.seq": seq }] }).catch(() => {});
          node.auditRef = event.auditChain;
        }
      }
      return { ok: true, node };
    }
    return { ok: false, error: "Could not append evidence after several attempts." };
  } catch (err) {
    console.error("recordEvidence failed:", err.message);
    return { ok: false, error: err.message };
  }
}

/** Small, non-sensitive metadata copied into the readable activity feed. */
function safeMeta(data) {
  const out = {};
  for (const k of ["documentHash", "templateId", "templateVersion", "sourceDataHash", "calculationHash", "shareId", "expiresAt", "reason", "decision", "checks", "errors", "warnings", "state", "mode", "recipient", "storageKey"]) {
    if (data[k] !== undefined) out[k] = typeof data[k] === "object" ? JSON.stringify(data[k]).slice(0, 400) : data[k];
  }
  return out;
}

/** Recomputes the whole evidence chain from the stored nodes. */
export function verifyEvidenceChain(nodes = []) {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const n of nodes) {
    if (n.seq !== expectedSeq) return { valid: false, brokenAtSeq: n.seq, reason: `expected seq ${expectedSeq}` };
    if (n.prevNodeHash !== prev) return { valid: false, brokenAtSeq: n.seq, reason: "prevNodeHash does not match the previous node" };
    const { nodeHash, auditRef, ...rest } = n;
    if (canonicalHash(n.data) !== n.dataHash) return { valid: false, brokenAtSeq: n.seq, reason: "node data does not match its dataHash" };
    if (sha(prev + canonicalStringify(rest)) !== nodeHash) return { valid: false, brokenAtSeq: n.seq, reason: "node content does not match its hash" };
    prev = nodeHash;
    expectedSeq += 1;
  }
  return { valid: true, count: nodes.length, head: nodes.length ? prev : GENESIS };
}

/** Evidence root at a given sequence (used to fix the manifest's
 *  evidenceRoot at finalization, before later delivery nodes extend the chain). */
export function evidenceRootAt(nodes = [], seq) {
  const n = nodes.find((x) => x.seq === seq);
  return n ? n.nodeHash : nodes.length ? nodes[nodes.length - 1].nodeHash : GENESIS;
}

// ---------------------------------------------------------------------
// Evidence Graph linkage (SOW §12) -- reuses businessEvents.js
// ---------------------------------------------------------------------
const SYNTHETIC_OWNER = { role: "owner" }; // a system-level recording is not gated by the acting user's own role (same pattern as AI Security / NAS)

const SOURCE_TARGET_TYPES = { INVOICE: "INVOICE", PURCHASE_ORDER: "PURCHASE_ORDER", SUPPLIER: "SUPPLIER" };

/** Creates (idempotently) the document's Business Event and wires typed
 *  relationships: SOURCED_FROM each source record, DERIVED_FROM the
 *  previous version, and -- for invoice-backed documents -- PROVEN_BY on the
 *  invoice's own event so the existing invoice evidence view shows it. */
export async function linkEvidenceGraph({ orgId, doc, actorEmail, previousDocumentId }) {
  try {
    const { businessEvents, invoices } = await getOrgCollections();
    let event = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "GENERATED_DOCUMENT", subjectId: doc._id, deletedAt: null });
    if (!event) {
      const created = await createBusinessEvent({ orgId, subjectType: "GENERATED_DOCUMENT", subjectId: doc._id, membership: SYNTHETIC_OWNER, actorEmail, relationships: [] });
      if (created.error) return { ok: false, error: created.error };
      event = created.event;
    }
    const eventId = String(event._id);
    const have = new Set((event.relationships || []).map((r) => `${r.type}:${r.targetType}:${r.targetId}`));
    const add = async (type, targetType, targetId, note) => {
      if (!targetId) return;
      const key = `${type}:${targetType}:${targetId}`;
      if (have.has(key)) return;
      have.add(key);
      await addBusinessEventRelationship({ orgId, eventId, membership: SYNTHETIC_OWNER, actorEmail, type, targetType, targetId, note });
    };
    for (const r of doc.manifestSourceRecords || doc.sourceRecords || []) {
      if (r.type === "BUSINESS_INSIGHTS") continue;
      await add("SOURCED_FROM", r.type, r.id, `Source snapshot ${String(doc.sourceDataHash || "").slice(0, 16)}`);
    }
    if (previousDocumentId) await add("DERIVED_FROM", "GENERATED_DOCUMENT", String(previousDocumentId), `Supersedes v${(doc.documentVersion || 2) - 1}`);

    if (doc.sourceRecordType === "INVOICE") {
      const invoiceEvent = await businessEvents.findOne({ orgId: toObjectId(orgId), subjectType: "INVOICE", subjectId: doc.sourceRecordId, deletedAt: null });
      let invoiceEventId = invoiceEvent ? String(invoiceEvent._id) : null;
      if (!invoiceEventId) {
        const inv = await invoices.findOne({ _id: doc.sourceRecordId, orgId: toObjectId(orgId) });
        if (inv) {
          const created = await createBusinessEvent({ orgId, subjectType: "INVOICE", subjectId: doc.sourceRecordId, membership: SYNTHETIC_OWNER, actorEmail, relationships: [] });
          if (!created.error) invoiceEventId = String(created.event._id);
        }
      }
      if (invoiceEventId) {
        await addBusinessEventRelationship({ orgId, eventId: invoiceEventId, membership: SYNTHETIC_OWNER, actorEmail, type: "PROVEN_BY", targetType: "GENERATED_DOCUMENT", targetId: String(doc._id), note: `${doc.documentNumber} v${doc.documentVersion}` }).catch(() => {});
      }
    }
    await generatedDocuments_setEvent(orgId, doc._id, eventId);
    return { ok: true, eventId };
  } catch (err) {
    console.error("linkEvidenceGraph failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function generatedDocuments_setEvent(orgId, docId, eventId) {
  const { generatedDocuments } = await getOrgCollections();
  await generatedDocuments.updateOne({ _id: docId, orgId: toObjectId(orgId) }, { $set: { businessEventId: toObjectId(eventId) } });
}

/** Attaches an approval (APPROVED_BY) or execution relationship to the event. */
export async function addDocumentRelationship({ orgId, doc, type, targetType, targetId, note, actorEmail }) {
  try {
    if (!doc.businessEventId) return { ok: false, error: "No evidence event yet." };
    await addBusinessEventRelationship({ orgId, eventId: String(doc.businessEventId), membership: SYNTHETIC_OWNER, actorEmail, type, targetType, targetId, note });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
