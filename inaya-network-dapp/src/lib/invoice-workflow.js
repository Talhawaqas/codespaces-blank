// src/lib/invoice-workflow.js
//
// Invoice lifecycle — same {from,to,requiresManage,activityAction}
// transition-table pattern as task-workflow.js/purchase-request-workflow.js,
// with one deliberate exception: SENT -> OVERDUE is NOT a user-invoked
// action in this table at all. Unlike Tasks' dueDate (a computed
// isOverdue flag, never a stored transition), the SOW lists Overdue as a
// real peer status to Draft/Sent/Paid/Cancelled, so it's cron-driven —
// see markOverdueInvoices(), called by
// src/app/api/cron/invoices-mark-overdue/route.js on the same nightly
// CRON_SECRET pattern as checkpoint-reputation/rag-reingest.
//
// ACCESS: canAccessFinance to view, canManageFinance (or org manager) to
// send/markPaid/cancel — a real approval boundary, unlike Tasks'
// "anyone in the department" model, matching the SOW's explicit Finance
// Manager vs. Finance Staff split. requiresManage below means
// canManageFinance, not canManageOrg directly.

import { getOrgCollections, canAccessDepartment, canManageFinance, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const INVOICE_STATES = ["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED"];

export const INVOICE_TRANSITIONS = {
  send: { from: "DRAFT", to: "SENT", activityAction: "INVOICE_SENT" },
  markPaid: { from: ["SENT", "OVERDUE"], to: "PAID", activityAction: "INVOICE_PAID" },
  cancel: { from: ["DRAFT", "SENT", "OVERDUE"], to: "CANCELLED", activityAction: "INVOICE_CANCELLED" },
};

export async function transitionInvoice({ orgId, invoiceId, action, membership, actorEmail, note }) {
  const definition = INVOICE_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { invoices } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const invoiceObjectId = toObjectId(invoiceId);

  const invoice = await invoices.findOne({ _id: invoiceObjectId, orgId: orgObjectId, deletedAt: null });
  if (!invoice) return { error: "Invoice not found.", status: 404 };
  if (!canAccessDepartment(membership, invoice.departmentId)) return { error: "You don't have permission to do that.", status: 403 };
  if (!canManageFinance(membership)) return { error: "Only a Finance Manager or an owner/admin can do that.", status: 403 };

  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;
  const now = new Date().toISOString();
  const updateFields = { status: definition.to, updatedAt: now };

  const updated = await invoices.findOneAndUpdate(
    { _id: invoiceObjectId, orgId: orgObjectId, status: fromFilter },
    { $set: updateFields },
    { returnDocument: "after" }
  );
  if (!updated) {
    const expected = Array.isArray(definition.from) ? definition.from.join("/") : definition.from;
    return { error: `This invoice isn't in ${expected} state (it's currently ${invoice.status}), so "${action}" can't be applied.`, status: 409 };
  }

  await logOrgActivity({
    orgId: orgObjectId, recordType: "INVOICE", recordId: invoiceObjectId, actorEmail,
    action: definition.activityAction,
    previousState: Array.isArray(definition.from) ? invoice.status : definition.from,
    newState: definition.to, metadata: note ? { note } : {},
  });

  return { invoice: updated };
}

/** Cron-driven, not user-invoked (see header comment). Flips every SENT
 *  invoice whose dueDate has passed to OVERDUE, org-wide across every
 *  org — no membership/permission check needed since this isn't reachable
 *  from any user-facing route, only the CRON_SECRET-gated cron route. */
export async function markOverdueInvoices() {
  const { invoices } = await getOrgCollections();
  const now = new Date().toISOString();
  const dueInvoices = await invoices.find({ status: "SENT", dueDate: { $lt: now }, deletedAt: null }).toArray();

  let flipped = 0;
  for (const invoice of dueInvoices) {
    const updated = await invoices.findOneAndUpdate(
      { _id: invoice._id, status: "SENT" },
      { $set: { status: "OVERDUE", updatedAt: now } },
      { returnDocument: "after" }
    );
    if (updated) {
      flipped += 1;
      await logOrgActivity({
        orgId: invoice.orgId, recordType: "INVOICE", recordId: invoice._id, actorEmail: "system:cron",
        action: "INVOICE_OVERDUE", previousState: "SENT", newState: "OVERDUE", metadata: {},
      });
    }
  }
  return { checked: dueInvoices.length, flipped };
}
