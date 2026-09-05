// src/lib/health-billing.js
//
// Healthcare & Legal Expansion SOW, Phase 4 (§10.16) — patient billing.
// Extends invoice-workflow.js's exact TRANSITIONS-table pattern rather
// than building a parallel billing engine — the existing `invoices`
// collection already has everything a patient invoice needs (lineItems,
// subtotal, total, currency, status). The one real schema addition is
// `billedToType: "crmContact" | "healthPatient"` alongside the existing
// `contactId` field, so an invoice can bill either kind of party without
// two parallel invoice collections.

import { getOrgCollections, toObjectId, canAccessFinance } from "./orgs.js";
import { canAccessHealthRecords } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function createPatientInvoice({ orgId, departmentId, patientId, lineItems, currency, dueDate, notes, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership) && !canAccessFinance(membership)) {
    return { error: "You don't have permission to bill a patient.", status: 403 };
  }
  const { invoices, healthPatients } = await getOrgCollections();
  const patient = await healthPatients.findOne({ _id: toObjectId(patientId), orgId: toObjectId(orgId), deletedAt: null });
  if (!patient) return { error: "Patient not found.", status: 404 };

  const subtotal = (lineItems || []).reduce((sum, item) => sum + (item.amount || 0) * (item.quantity || 1), 0);
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), departmentId: departmentId ? toObjectId(departmentId) : null,
    billedToType: "healthPatient", contactId: toObjectId(patientId),
    invoiceNumber: `HB-${Date.now()}`, issueDate: now, dueDate: dueDate || now,
    lineItems: lineItems || [], subtotal, total: subtotal, currency: currency || "USD",
    status: "DRAFT", notes: notes || "",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await invoices.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "INVOICE", recordId: inserted._id, actorEmail, action: "PATIENT_INVOICE_CREATED", previousState: null, newState: "DRAFT", metadata: { patientId } });
  return { invoice: inserted };
}

export async function listInvoicesForPatient(orgId, patientId) {
  const { invoices } = await getOrgCollections();
  return invoices.find({ orgId: toObjectId(orgId), billedToType: "healthPatient", contactId: toObjectId(patientId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
}
