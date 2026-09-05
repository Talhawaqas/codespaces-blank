// src/lib/legal-billing-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 8 (§11.24) — legal billing.
// Extends invoice-workflow.js's TRANSITIONS pattern against a SEPARATE
// `legal_billing` collection (not the generic `invoices` collection
// health-billing.js uses) since legal billing has real domain concepts
// invoices don't — hourly/fixed/retainer arrangements and a direct link
// to the specific time entries being billed, locking each one via
// legal-time-tracking.js's lockTimeEntryAsBilled so a time entry can
// never be billed twice.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters, canManageLegal } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";
import { listUnbilledApprovedTimeEntries, lockTimeEntryAsBilled } from "./legal-time-tracking.js";

export const LEGAL_BILLING_STATES = ["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED"];

export const LEGAL_BILLING_TRANSITIONS = {
  send: { from: "DRAFT", to: "SENT", activityAction: "SENT" },
  markPaid: { from: ["SENT", "OVERDUE"], to: "PAID", activityAction: "PAID" },
  cancel: { from: ["DRAFT", "SENT"], to: "CANCELLED", activityAction: "CANCELLED" },
};

/** Generates a legal_billing invoice from a matter's currently-unbilled,
 *  APPROVED time entries for an hourly arrangement — locking each entry
 *  as billed atomically per-entry (a partial failure mid-loop leaves
 *  already-locked entries correctly billed and unlocked ones still
 *  available for the next billing run, never double-counted either way). */
export async function generateHourlyInvoice({ orgId, matterId, clientId, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to generate a bill.", status: 403 };
  const unbilled = await listUnbilledApprovedTimeEntries(orgId, matterId);
  if (!unbilled.length) return { error: "No unbilled, approved time entries for this matter.", status: 409 };

  const lineItems = [];
  const lockedIds = [];
  for (const entry of unbilled) {
    if (!entry.billable) continue;
    const locked = await lockTimeEntryAsBilled({ orgId, timeEntryId: entry._id });
    if (!locked) continue; // raced with another billing run — skip, don't double count
    lockedIds.push(entry._id);
    const rate = entry.rate || 0;
    lineItems.push({ description: entry.taskDescription, hours: entry.minutes / 60, rate, amount: (entry.minutes / 60) * rate });
  }
  if (!lineItems.length) return { error: "No billable time entries could be locked for billing.", status: 409 };

  const subtotal = lineItems.reduce((sum, li) => sum + li.amount, 0);
  const { legalBilling } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), clientId: clientId ? toObjectId(clientId) : null,
    arrangement: "hourly", timeEntryIds: lockedIds, lineItems, subtotal, total: subtotal, currency: "USD",
    status: "DRAFT", createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalBilling.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "LEGAL_BILLING", recordId: inserted._id, actorEmail, action: "GENERATED", previousState: null, newState: "DRAFT", metadata: { matterId, entryCount: lockedIds.length } });
  return { billing: inserted };
}

export async function createFixedOrRetainerBilling({ orgId, matterId, clientId, arrangement, amount, description, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to create a bill.", status: 403 };
  if (!["fixed", "retainer"].includes(arrangement)) return { error: `Unknown arrangement "${arrangement}".`, status: 400 };
  const { legalBilling } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), matterId: toObjectId(matterId), clientId: clientId ? toObjectId(clientId) : null,
    arrangement, timeEntryIds: [], lineItems: [{ description: description || arrangement, amount }], subtotal: amount, total: amount, currency: "USD",
    status: "DRAFT", createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalBilling.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "LEGAL_BILLING", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "DRAFT", metadata: { matterId, arrangement } });
  return { billing: inserted };
}

export async function transitionLegalBilling({ orgId, billingId, action, actorEmail, membership }) {
  if (!canManageLegal(membership)) return { error: "Only a legal manager or the owner/admin can update billing status.", status: 403 };
  const definition = LEGAL_BILLING_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { legalBilling } = await getOrgCollections();
  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;
  const current = await legalBilling.findOne({ _id: toObjectId(billingId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Billing record not found.", status: 404 };

  const updated = await legalBilling.findOneAndUpdate(
    { _id: toObjectId(billingId), orgId: toObjectId(orgId), status: fromFilter },
    { $set: { status: definition.to, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const expected = Array.isArray(definition.from) ? definition.from.join("/") : definition.from;
    return { error: `This billing record isn't in ${expected} state (it's currently ${current.status}).`, status: 409 };
  }
  await logOrgActivity({ orgId, recordType: "LEGAL_BILLING", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: current.status, newState: definition.to, metadata: {} });
  return { billing: updated };
}
