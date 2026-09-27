// src/lib/help.js
//
// "Help & Support" for Inaya's OWN users. The Customer Portal SOW built a support desk that any organization can run for its customers. This wires
// Inaya's users (Business Workspace members, dApp visitors) to Inaya's own support desk, which is simply one organization that runs that desk:
//   INAYA_SUPPORT_ORG_ID       the organization whose Customer Support module receives Inaya's tickets (a server setting, never client-supplied)
//   INAYA_SUPPORT_NOTIFY_EMAIL optional: a mailbox (for example the support alias) that also gets an email copy of every new ticket, with the
//                              requester's address as Reply-To, so support staff can answer straight from that mailbox
// Nothing new is stored: a ticket is created through the same pipeline the customer portal uses (routing, SLA, AI triage, evidence, audit).

import { ensureOrgIndexes, getOrgCollections, getMembership, toObjectId } from "./orgs.js";
import { getSettings } from "./support/settings.js";
import { submitTicket } from "./support/flows.js";
import { findContactByEmail, createLeadContact } from "./support/customers.js";
import { sendEmail } from "./email.js";

const MAX_SUBJECT = 200; const MAX_BODY = 8000;

/** Inaya's support desk, or null when it has not been configured (or the organization does not exist). */
export async function getSupportDesk() {
  const id = process.env.INAYA_SUPPORT_ORG_ID;
  if (!id || !/^[0-9a-f]{24}$/i.test(id)) return null;
  await ensureOrgIndexes();
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(id) }, { projection: { name: 1 } });
  if (!org) return null;
  const settings = await getSettings(id);
  return { orgId: id, settings, portalPath: settings.portalEnabled && settings.portalSlug ? `/portal/${settings.portalSlug}` : null };
}

/** What the UI needs to know: is there a desk, and where is its portal. No secrets, no organization id. */
export async function getHelpConfig() {
  const desk = await getSupportDesk();
  return { enabled: !!desk, portalPath: desk?.portalPath || null };
}

const clean = (s, max) => String(s ?? "").replace(/\u0000/g, "").trim().slice(0, max);

/**
 * Files a ticket for a signed-in user. `session.email` is the verified identity (never a client-supplied address). `customerOrgId` is optional context
 * and is honored ONLY if that user is an active member of it.
 */
export async function createHelpTicket({ session, subject, description, type, category, customerOrgId, page, idempotencyKey }) {
  const desk = await getSupportDesk();
  if (!desk) return { error: "Inaya support is not available right now. Please try again later.", status: 503, reasonCode: "NOT_CONFIGURED" };
  const subj = clean(subject, MAX_SUBJECT).replace(/\s+/g, " "); const desc = clean(description, MAX_BODY);
  if (subj.length < 3) return { error: "Please give your request a short title (at least 3 characters).", status: 400 };
  if (desc.length < 10) return { error: "Please describe what you need (at least 10 characters).", status: 400 };

  let customerOrganization = null;
  if (customerOrgId && /^[0-9a-f]{24}$/i.test(String(customerOrgId))) {
    const membership = await getMembership(customerOrgId, session.email);
    if (membership) { const { orgs } = await getOrgCollections(); const org = await orgs.findOne({ _id: toObjectId(customerOrgId) }, { projection: { name: 1 } }); if (org) customerOrganization = { id: String(org._id), name: org.name }; }
  }

  // with open sign-up the requester gets a customer record so they can also track the ticket in the portal; otherwise the ticket still reaches the team
  if (desk.settings.signup === "open" && !(await findContactByEmail(desk.orgId, session.email))) { try { await createLeadContact({ orgId: desk.orgId, email: session.email }); } catch { /* the ticket does not depend on it */ } }

  const t = desk.settings.customerSelectableTypes?.includes(type) ? type : "Other";
  const cat = desk.settings.categories?.includes(category) ? category : "General";
  const r = await submitTicket({
    orgId: desk.orgId, settings: desk.settings, actor: { type: "customer", email: session.email }, requester: { email: session.email }, subject: subj, description: desc,
    type: t, category: cat, channel: "PORTAL", idempotencyKey: idempotencyKey ? `help:${session.email}:${String(idempotencyKey).slice(0, 80)}` : null,
    customFields: {}, tags: ["inaya-app", ...(customerOrganization ? [`org:${customerOrganization.name}`.slice(0, 60)] : [])],
  });
  if (r.error) return { error: r.error, status: r.status || 400 };
  if (!r.duplicate) await notifySupportMailbox({ number: r.ticket.number, subject: subj, description: desc, email: session.email, customerOrganization, page });
  return { ticketNumber: r.ticket.number, duplicate: !!r.duplicate, portalPath: desk.portalPath, customerOrganization: customerOrganization?.name || null, page: page ? clean(page, 200) : null };
}

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Email copy of a new ticket to the configured support mailbox. Best effort: the ticket already exists, so a mail failure never fails the request. */
export async function notifySupportMailbox({ number, subject, description, email, customerOrganization, page }) {
  const to = process.env.INAYA_SUPPORT_NOTIFY_EMAIL;
  if (!to || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)) return { sent: false, reason: "not_configured" };
  const lines = [`Ticket ${number}`, `From: ${email}`, ...(customerOrganization ? [`Organization: ${customerOrganization.name}`] : []), ...(page ? [`Page: ${page}`] : [])];
  try {
    return await sendEmail({
      to, replyTo: email, subject: `[Support ${number}] ${subject}`.slice(0, 220),
      text: `${lines.join("\n")}\n\n${description}\n\nReply to this email to answer the requester directly.`,
      html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px"><p><b>Ticket ${esc(number)}</b><br>From: ${esc(email)}${customerOrganization ? `<br>Organization: ${esc(customerOrganization.name)}` : ""}${page ? `<br>Page: ${esc(page)}` : ""}</p><pre style="white-space:pre-wrap;font:inherit">${esc(description)}</pre><p style="color:#5d6b7a">Reply to this email to answer the requester directly.</p></div>`,
    });
  } catch (err) { console.error("help: support mailbox notification failed:", err?.message || err); return { sent: false, reason: "error" }; }
}
