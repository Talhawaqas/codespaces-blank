// src/lib/auditChain.js
//
// Phase 2 — Cryptographic Audit Trail. A hash-chained, tamper-evident
// overlay on top of the existing plain-insert logs (org-activity-log.js,
// activity-log.js, security.js's event recording) — those functions keep
// writing the same human-readable event they always have; this module
// additionally appends a linked, verifiable entry so a direct database
// edit to any of them can be detected after the fact.
//
// entryHash = sha256(prevHash + canonicalJSON(eventFields)) — each entry
// commits to the entire chain before it, not just its own content, so
// altering or deleting any past entry breaks every hash after it.
//
// CONCURRENCY: one org's chain is a strictly sequential structure (entry N
// must know entry N-1's real, committed hash), so this can't be made
// race-safe with a single atomic $inc the way a maxUses counter can —
// appendAuditEntry instead does an optimistic compare-and-swap on
// audit_chain_heads (claim only succeeds if the head hasn't moved since it
// was read) and retries on conflict. Under real contention this means a
// few wasted reads, never a corrupted chain: a conflicting write always
// fails closed rather than silently overwriting.

import { createHash, randomUUID } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";

const GENESIS_HASH = "0".repeat(64);
const MAX_APPEND_ATTEMPTS = 8;

function canonicalize(fields) {
  // Stable key order so the same logical event always hashes the same way
  // regardless of property insertion order.
  return JSON.stringify(fields, Object.keys(fields).sort());
}

function computeEntryHash(prevHash, canonicalFields) {
  return createHash("sha256").update(prevHash + canonicalFields).digest("hex");
}

/** Appends one entry to orgId's audit chain. Returns the inserted entry.
 *  Callers pass the same shape of fields they'd hand to logOrgActivity/
 *  logDocumentActivity — this doesn't replace those calls, it runs
 *  alongside them (see the wiring in org-activity-log.js/activity-log.js). */
export async function appendAuditEntry({ orgId, recordType, recordId, actorEmail, action, previousState, newState, metadata }) {
  const { auditChainEntries, auditChainHeads } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);

  const eventFields = {
    recordType,
    recordId: recordId ? recordId.toString() : null,
    actorEmail: actorEmail || null,
    action,
    previousState: previousState ?? null,
    newState: newState ?? null,
    timestamp: new Date().toISOString(),
    metadata: metadata || {},
  };
  const canonicalFields = canonicalize(eventFields);

  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const head = await auditChainHeads.findOne({ orgId: orgObjectId });
    const lastSeq = head?.lastSeq || 0;
    const prevHash = head?.lastHash || GENESIS_HASH;
    const seq = lastSeq + 1;
    const entryHash = computeEntryHash(prevHash, canonicalFields);

    // Optimistic CAS: only advance the head if it still matches what we
    // just read (lastSeq for an existing head; no document at all for the
    // very first entry). Either branch modifying/creating exactly one
    // document means we own this seq number; zero means someone else beat
    // us to it and we retry against the new head.
    const filter = head ? { orgId: orgObjectId, lastSeq } : { orgId: orgObjectId };
    let claimed;
    try {
      claimed = await auditChainHeads.findOneAndUpdate(
        filter,
        { $set: { orgId: orgObjectId, lastSeq: seq, lastHash: entryHash } },
        { upsert: !head, returnDocument: "after" }
      );
    } catch (err) {
      // Concurrent upsert on the unique {orgId} index — someone else just
      // created the head document first; retry against it.
      if (err?.code === 11000) continue;
      throw err;
    }
    if (!claimed || claimed.lastSeq !== seq) continue;

    const entry = { eventId: randomUUID(), orgId: orgObjectId, seq, prevHash, entryHash, ...eventFields };
    await auditChainEntries.insertOne(entry);
    return entry;
  }

  throw new Error(`auditChain: failed to append after ${MAX_APPEND_ATTEMPTS} attempts (org ${orgId} under heavy concurrent write load)`);
}

/** Walks orgId's whole chain and recomputes every hash. Returns
 *  { valid: true, count } or { valid: false, count, brokenAtSeq, reason }
 *  — a direct DB edit to any entry's stored fields, or a deleted/
 *  reordered entry, changes the recomputed hash and is caught here. */
export async function verifyChainIntegrity(orgId) {
  const { auditChainEntries } = await getOrgCollections();
  const entries = await auditChainEntries.find({ orgId: toObjectId(orgId) }).sort({ seq: 1 }).toArray();

  let expectedPrevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, reason: `expected seq ${expectedSeq}, found ${entry.seq} (a gap or reorder)` };
    }
    if (entry.prevHash !== expectedPrevHash) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, reason: "prevHash does not match the prior entry's hash" };
    }
    const { _id, eventId, orgId: _o, seq: _s, prevHash: _p, entryHash, ...eventFields } = entry;
    const recomputed = computeEntryHash(expectedPrevHash, canonicalize(eventFields));
    if (recomputed !== entryHash) {
      return { valid: false, count: entries.length, brokenAtSeq: entry.seq, reason: "entry content does not match its recorded hash — this entry was altered after being written" };
    }
    expectedPrevHash = entryHash;
    expectedSeq += 1;
  }

  return { valid: true, count: entries.length };
}

export async function listAuditChain(orgId, { limit = 200 } = {}) {
  const { auditChainEntries } = await getOrgCollections();
  return auditChainEntries.find({ orgId: toObjectId(orgId) }).sort({ seq: -1 }).limit(limit).toArray();
}
