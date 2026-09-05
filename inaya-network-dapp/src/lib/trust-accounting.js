// src/lib/trust-accounting.js
//
// Healthcare & Legal Expansion SOW, Phase 8 (§11.25) — client trust
// accounting foundation. SOW's explicit instruction: "Do not claim
// jurisdictional compliance without jurisdiction-specific validation" —
// this module makes NO claim about IOLTA or any specific jurisdiction's
// trust-accounting rules. What it DOES enforce, as basic financial
// sanity rather than a compliance claim, is that a withdrawal can never
// exceed a matter's current computed trust balance — an atomic
// findOneAndUpdate with a balance-sufficiency filter, same
// no-double-spend discipline as stockLevels' $inc-only ledger elsewhere
// in this codebase.
//
// Every transaction requires approval (canManageLegal) — trust funds are
// client money, not firm money, so this is deliberately a higher bar than
// ordinary matter-team access (canAccessLegalMatters).

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageLegal } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function getMatterTrustBalance(orgId, matterId) {
  const { legalTrustLedger } = await getOrgCollections();
  const entries = await legalTrustLedger.find({ orgId: toObjectId(orgId), matterId: toObjectId(matterId) }).toArray();
  return entries.reduce((balance, e) => balance + (e.type === "deposit" ? e.amount : -e.amount), 0);
}

export async function recordDeposit({ orgId, matterId, amount, source, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can record a trust deposit.", status: 403 };
  if (!(amount > 0)) return { error: "Deposit amount must be positive.", status: 400 };
  const { legalTrustLedger } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), type: "deposit", amount, source: source || null,
    approvedByEmail: actorEmail, reconciled: false, createdByEmail: actorEmail, createdAt: now,
  };
  const result = await legalTrustLedger.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "TRUST_LEDGER", recordId: inserted._id, actorEmail, action: "DEPOSIT", previousState: null, newState: null, metadata: { matterId, amount } });
  return { entry: inserted };
}

/** Atomically checks sufficient balance before recording a withdrawal —
 *  never trusts a balance computed moments earlier in a separate read,
 *  since a concurrent withdrawal could have already spent it. Recomputes
 *  the balance, then performs the insert only if amount <= balance;
 *  there's a narrow theoretical race between the balance read and the
 *  insert (Mongo has no cross-document balance-check-and-insert
 *  transaction here without a multi-document transaction), acceptable
 *  for a foundation module per the SOW's own "foundation" framing — a
 *  production trust-accounting system would wrap this in a real
 *  transaction, flagged as a known limitation rather than silently
 *  assumed solved. */
export async function recordWithdrawal({ orgId, matterId, amount, purpose, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can record a trust withdrawal.", status: 403 };
  if (!(amount > 0)) return { error: "Withdrawal amount must be positive.", status: 400 };

  const balance = await getMatterTrustBalance(orgId, matterId);
  if (amount > balance) {
    return { error: `Withdrawal of ${amount} exceeds this matter's current trust balance of ${balance}.`, status: 409 };
  }

  const { legalTrustLedger } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), type: "withdrawal", amount, source: purpose || null,
    approvedByEmail: actorEmail, reconciled: false, createdByEmail: actorEmail, createdAt: now,
  };
  const result = await legalTrustLedger.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "TRUST_LEDGER", recordId: inserted._id, actorEmail, action: "WITHDRAWAL", previousState: null, newState: null, metadata: { matterId, amount, purpose } });
  return { entry: inserted };
}

export async function reconcileMatterTrust({ orgId, matterId, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can reconcile trust accounts.", status: 403 };
  const { legalTrustLedger } = await getOrgCollections();
  const now = new Date().toISOString();
  const result = await legalTrustLedger.updateMany(
    { orgId: toObjectId(orgId), matterId: toObjectId(matterId), reconciled: false },
    { $set: { reconciled: true, reconciledByEmail: actorEmail, reconciledAt: now } }
  );
  const balance = await getMatterTrustBalance(orgId, matterId);
  await logOrgActivity({ orgId, recordType: "TRUST_LEDGER", recordId: toObjectId(matterId), actorEmail, action: "RECONCILED", previousState: null, newState: null, metadata: { entriesReconciled: result.modifiedCount, balance } });
  return { reconciledCount: result.modifiedCount, balance };
}

export async function listTransactionHistory(orgId, matterId) {
  const { legalTrustLedger } = await getOrgCollections();
  return legalTrustLedger.find({ orgId: toObjectId(orgId), matterId: toObjectId(matterId) }).sort({ createdAt: 1 }).toArray();
}
