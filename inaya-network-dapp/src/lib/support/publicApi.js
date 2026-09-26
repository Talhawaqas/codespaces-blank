// src/lib/support/publicApi.js
//
// SOW §28: the public support API (/api/public/v1/support/*). Authenticated by a support-kind API key (apiKeys.js):
//   * the organization comes ONLY from the key;
//   * each endpoint needs a named scope; keys can expire and be revoked;
//   * a key BOUND to a customer acts as that customer and can never see another customer's data;
//   * an unbound (service) key names the customer per request, and still receives only the customer-safe views:
//     internal notes, routing and AI output are never part of this API;
//   * POSTs honour Idempotency-Key: a retried create returns the original ticket instead of a second one.

import { fail, normEmail, isEmail, toPlainText } from "./common.js";
import { requireSupportApiKey } from "./apiKeys.js";
import * as T from "./tickets.js";
import * as M from "./messages.js";
import * as C from "./customers.js";
import * as K from "./kb.js";
import * as I from "./ideas.js";
import * as A from "./ai.js";
import * as Q from "./queues.js";
import { submitTicket, customerSolve } from "./flows.js";
import { addAttachment } from "./attachments.js";
import { ensurePortalUser } from "./portalAuth.js";
import { getSupportCollections } from "./db.js";
import { toObjectId } from "../orgs.js";
import { audit } from "./record.js";

const ticketOut = (v) => v;

/** The customer this request acts for: the bound customer, or the one named by an unbound key. */
async function customerFor(ctx, named) {
  const email = ctx.customerEmail || normEmail(named);
  if (!isEmail(email)) return { error: ctx.customerEmail ? "This key has no valid customer." : "customerEmail is required for this key.", status: 400 };
  if (ctx.customerEmail && named && normEmail(named) !== ctx.customerEmail) return fail("This key is bound to a different customer.", 403, { reasonCode: "KEY_BOUND" });
  const contact = await C.findContactByEmail(ctx.orgId, email);
  return { email, contact };
}

export async function handlePublic({ method, path, query, body, req }) {
  const [a, b, c] = path;
  const G = method === "GET"; const P = method === "POST";
  const scopeFor = () => {
    if (a === "tickets") return G ? "tickets:read" : (c === "attachments" ? "attachments:write" : "tickets:write");
    if (a === "knowledge") return "knowledge:read"; if (a === "invoices") return "invoices:read"; if (a === "queues" || a === "categories") return "queues:read";
    if (a === "customers") return "customers:read"; if (a === "ideas") return "ideas:write"; if (a === "ai") return "ai:chat"; if (a === "events") return "events:read";
    return null;
  };
  const scope = scopeFor();
  if (!scope) return fail("Unknown endpoint.", 404);
  const auth = await requireSupportApiKey(req, scope);
  if (auth.error) return auth;
  const { ctx } = auth; const orgId = ctx.orgId; const settings = ctx.settings;
  const idem = P ? req.headers.get("idempotency-key") : null;
  if (idem && (idem.length < 8 || idem.length > 100)) return fail("Idempotency-Key must be 8-100 characters.");

  // ------------------------------------------------------------------ tickets
  if (a === "tickets") {
    if (!b) {
      if (G) {
        const cu = await customerFor(ctx, query.customerEmail); if (cu.error) return cu;
        const r = await T.listTicketsForCustomer({ orgId, user: { email: cu.email }, status: query.status || null, limit: Math.min(100, Number(query.limit) || 25), skip: Number(query.skip) || 0 });
        return { tickets: r.tickets.map(({ latestReply, ...t }) => t), total: r.total };
      }
      if (P) {
        const cu = await customerFor(ctx, body.customerEmail || body.requesterEmail); if (cu.error) return cu;
        const type = settings.customerSelectableTypes.includes(body.type) ? body.type : "Other";
        const r = await submitTicket({ orgId, settings, actor: { type: "api", email: cu.email, name: cu.contact?.name }, requester: { email: cu.email, name: cu.contact?.name || null }, subject: body.subject, description: body.description, type, category: body.category, priority: body.priority, channel: "API", linkedInvoiceNumber: body.linkedInvoiceNumber || null, unverified: !cu.contact, idempotencyKey: idem ? `api:${ctx.keyId}:${idem}` : null });
        if (r.error) return r;
        await audit({ orgId, ticketId: r.ticket._id, action: "TICKET_CREATED_VIA_API", actorEmail: ctx.actor.email, metadata: { keyId: ctx.keyId, duplicate: !!r.duplicate } });
        return { ticket: ticketOut(await T.getTicketForCustomer({ orgId, user: { email: cu.email }, ticketId: r.ticket._id, settings })), duplicate: !!r.duplicate, status: 201 };
      }
    }
    if (b) {
      const t = await T.loadTicket(orgId, b);
      // unbound keys act for the ticket's requester; bound keys only for their own customer
      if (!t) return fail("Ticket not found.", 404);
      const email = ctx.customerEmail || t.requester.email;
      const user = { email };
      const own = await T.getTicketForCustomer({ orgId, user, ticketId: b, settings });
      if (!own) return fail("Ticket not found.", 404);
      if (G && !c) return { ticket: own };
      if (P && c === "replies") {
        const r = await M.addReply({ orgId, settings, ticketId: b, author: { type: "api", email }, body: body.body });
        if (r.error) return r;
        return { message: r.message, status: 201 };
      }
      if (P && c === "close") { const r = await customerSolve({ orgId, settings, ticketId: b, user, canAct: true }); return r.error ? r : { ticket: await T.getTicketForCustomer({ orgId, user, ticketId: b, settings }) }; }
      if (P && c === "reopen") { const r = await T.reopen({ orgId, settings, ticketId: b, actor: { type: "api", email }, reason: toPlainText(body.reason, 300) || "Reopened via API" }); return r.error ? r : { ticket: await T.getTicketForCustomer({ orgId, user, ticketId: b, settings }) }; }
      if (P && c === "attachments") {
        let buffer; try { buffer = Buffer.from(String(body.contentBase64 || ""), "base64"); } catch { return fail("contentBase64 is not valid base64."); }
        const r = await addAttachment({ orgId, settings, ticketId: b, file: { filename: body.filename, buffer }, uploader: { type: "api", email }, visibility: "PUBLIC" });
        return r.error ? r : { attachment: r.attachment, status: 201 };
      }
    }
  }

  // ------------------------------------------------------------------ reference data
  if (a === "queues" && G) { const r = await Q.listQueues({ orgId, includeInactive: false }); return { queues: r.queues.map((q) => ({ id: q.queueId, name: q.name, description: q.description })) }; }
  if (a === "categories" && G) return { categories: settings.categories, types: settings.customerSelectableTypes };
  if (a === "knowledge" && G) {
    if (!settings.kb.enabled) return { results: [] };
    if (b) { const art = await K.getArticle({ orgId, slug: b, level: "CUSTOMERS" }); return art ? { article: art } : fail("Article not found.", 404); }
    return K.searchArticles({ orgId, q: query.q, level: "CUSTOMERS", limit: Math.min(20, Number(query.limit) || 10), track: false });
  }
  if (a === "invoices" && G) {
    const cu = await customerFor(ctx, query.customerEmail); if (cu.error) return cu;
    return { invoices: cu.contact ? await C.invoicesForContact(orgId, cu.contact._id, Math.min(100, Number(query.limit) || 25)) : [] };
  }
  if (a === "customers" && b === "me" && G) {
    if (!ctx.customerEmail) return fail("customers/me needs a customer-bound key.", 400);
    const contact = await C.findContactByEmail(orgId, ctx.customerEmail);
    return { customer: { email: ctx.customerEmail, name: contact?.name || null, company: contact?.company || null, contactLinked: !!contact } };
  }

  // ------------------------------------------------------------------ ideas & AI chat (customer-bound keys only)
  if (a === "ideas" && P) {
    if (!ctx.customerEmail) return fail("Ideas need a customer-bound key.", 400);
    const user = await ensurePortalUser({ orgId, email: ctx.customerEmail }); if (!user) return fail("This customer is not a known contact.", 403);
    const r = await I.submitIdea({ orgId, settings, user, body });
    return r.error ? r : { ...r, status: 201 };
  }
  if (a === "ai" && b === "chat" && P) {
    if (!ctx.customerEmail) return fail("AI chat needs a customer-bound key.", 400);
    const user = await ensurePortalUser({ orgId, email: ctx.customerEmail }); if (!user) return fail("This customer is not a known contact.", 403);
    const r = await A.chat({ orgId, settings, user, sessionId: body.sessionId || null, message: body.message });
    return r.error ? r : { sessionId: r.session.sessionId, reply: r.reply };
  }

  // ------------------------------------------------------------------ events feed (service keys)
  if (a === "events" && G) {
    if (ctx.customerEmail) return fail("The events feed needs a service (unbound) key.", 403);
    const { supportEvents } = await getSupportCollections();
    const f = { orgId: toObjectId(orgId), analytics: { $ne: true } };
    if (query.since && !Number.isNaN(Date.parse(query.since))) f.createdAt = { $gt: new Date(query.since).toISOString() };
    const rows = await supportEvents.find(f).sort({ createdAt: 1 }).limit(Math.min(200, Number(query.limit) || 100)).toArray();
    return { events: rows.map((e) => ({ id: String(e._id), type: e.type, createdAt: e.createdAt, ticketId: e.ticketId ? String(e.ticketId) : null, data: e.data })) };
  }
  return fail("Unknown endpoint.", 404);
}
