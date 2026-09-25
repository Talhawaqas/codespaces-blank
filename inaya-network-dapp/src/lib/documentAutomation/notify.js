// src/lib/documentAutomation/notify.js
//
// Document Automation SOW §18/§30 -- notifications. Reuses the existing
// idempotent notification collection (notifications.js: createNotification
// upserts on dedupeKey, so a retried request or an overlapping cron run can
// never spam duplicates) and the existing email sender (email.js). Email is
// a NOTIFICATION channel only: it carries a secure link, never the
// document, and every send is recorded (recipient, document version, link
// id, timestamp, outcome). A notification failure is never allowed to fail
// the underlying operation.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { createNotification } from "../notifications.js";
import { sendEmail } from "../email.js";

const CATEGORY = "business";

async function safely(label, fn) {
  try { return await fn(); } catch (err) { console.error(`documentAutomation notify(${label}) failed (non-fatal):`, err.message); return null; }
}

export async function notifyUser({ orgId, targetEmail, type, severity = "info", title, body, doc, dedupeKey, actionUrl }) {
  return safely(type, () => createNotification({
    scope: "org", orgId, targetEmail, category: type.includes("approval") ? "approval" : CATEGORY, severity, type, title, body,
    sourceModule: "document-automation", sourceId: doc?._id, actionUrl: actionUrl || "/business?view=documentAutomation", dedupeKey,
    metadata: doc ? { documentId: String(doc._id), documentNumber: doc.documentNumber, documentVersion: doc.documentVersion } : {},
  }));
}

/** Everyone who could approve this document type: org owners/admins and, for
 *  finance documents, finance managers -- minus the requester. */
export async function listApprovers({ orgId, finance, excludeEmail }) {
  const { orgMembers } = await getOrgCollections();
  const or = [{ role: { $in: ["owner", "admin"] } }];
  if (finance) or.push({ financeRole: "manager" });
  const members = await orgMembers.find({ orgId: toObjectId(orgId), status: "active", $or: or }).toArray();
  return members.map((m) => m.email).filter((e) => e && e !== excludeEmail);
}

export async function notifyApprovers({ orgId, doc, finance, requesterEmail }) {
  const approvers = await listApprovers({ orgId, finance, excludeEmail: requesterEmail });
  await Promise.all(approvers.map((email) => notifyUser({
    orgId, targetEmail: email, type: "document_approval_required", severity: "warning",
    title: `Approval needed: ${doc.documentNumber} v${doc.documentVersion}`,
    body: `${doc.counterpartyName || "A document"} - ${doc.currency || ""} ${doc.grandTotal ?? ""}. Review the exact version and approve or reject.`,
    doc, dedupeKey: `${orgId}:document_approval_required:${doc._id}:${email}`,
  })));
  return approvers.length;
}

export async function notifyDecision({ orgId, doc, decision, actorEmail }) {
  if (!doc.approval?.requestedByEmail) return;
  await notifyUser({
    orgId, targetEmail: doc.approval.requestedByEmail, type: "document_approval_completed", severity: decision === "REJECTED" ? "warning" : "info",
    title: `${doc.documentNumber} v${doc.documentVersion} was ${decision.toLowerCase()}`,
    body: `Decided by ${actorEmail}${doc.approval.decisionNote ? ` - "${doc.approval.decisionNote}"` : ""}.`, doc,
    dedupeKey: `${orgId}:document_approval_completed:${doc._id}`,
  });
}

export async function notifyFailure({ orgId, doc, stage, message }) {
  if (!doc.createdByEmail) return;
  await notifyUser({
    orgId, targetEmail: doc.createdByEmail, type: "document_failure", severity: "critical",
    title: `${doc.documentNumber || "Document"} needs attention (${stage})`, body: String(message).slice(0, 300), doc,
    dedupeKey: `${orgId}:document_failure:${doc._id}:${stage}`,
  });
}

/** Sends the secure-link email and records the attempt on the delivery. */
export async function sendDeliveryEmail({ orgId, doc, delivery, url, senderName }) {
  const { documentDeliveries } = await getOrgCollections();
  const subject = `${senderName || "A document"} sent you ${doc.documentNumber}`;
  const text = `You have been sent ${doc.documentNumber} (version ${doc.documentVersion}).\n\nOpen it securely: ${url}\n\nThis link expires ${delivery.expiresAt ? new Date(delivery.expiresAt).toUTCString() : "soon"}. The document itself is not attached to this email.`;
  const html = `<p>You have been sent <strong>${escapeHtml(doc.documentNumber)}</strong> (version ${doc.documentVersion}).</p><p><a href="${escapeHtml(url)}">Open it securely</a></p><p style="color:#666">This link expires ${escapeHtml(delivery.expiresAt ? new Date(delivery.expiresAt).toUTCString() : "soon")}. The document itself is not attached to this email.</p>`;
  let state = "SENT";
  let error = null;
  try {
    const r = await sendEmail({ to: delivery.recipientEmail, subject, html, text });
    if (!r?.sent) { state = r?.reason === "not_configured" ? "NOT_CONFIGURED" : "FAILED"; error = r?.reason || "unknown"; }
  } catch (err) {
    state = "FAILED";
    error = err.message;
  }
  await documentDeliveries.updateOne({ _id: delivery._id }, { $set: { emailState: state, emailAttemptedAt: new Date().toISOString(), emailError: error }, $inc: { emailAttempts: 1 } });
  return { state, error };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
