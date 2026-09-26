// src/lib/support/portalApi.js
//
// The customer portal API, as one dispatcher. Security model (SOW §29, §41-§43, §57):
//   * the organization comes ONLY from the portal slug in the URL; a customer session is bound to one organization
//     and is looked up against THAT organization, so it can never act in another one;
//   * everything a customer reads passes through the customer projections in tickets.js (public messages and
//     customer-safe statuses only) and is filtered to tickets they own or were explicitly shared on;
//   * mutating requests need the X-Portal-Request header (a custom header cannot be sent cross-site without a CORS
//     preflight, which this API never grants) and a same-origin Origin when the browser sends one;
//   * limits (tickets/hour, replies/hour, chat/hour, sign-in requests) come from the organization's settings.

import { fail, toPlainText } from "./common.js";
import { checkRateLimit } from "../rateLimit.js";
import { toObjectId } from "../orgs.js";
import * as PA from "./portalAuth.js";
import * as T from "./tickets.js";
import * as M from "./messages.js";
import * as C from "./customers.js";
import * as K from "./kb.js";
import * as I from "./ideas.js";
import * as A from "./ai.js";
import { submitCsat } from "./csat.js";
import { submitTicket, customerSolve } from "./flows.js";
import { listIncidents } from "./incidents.js";
import { getSupportCollections } from "./db.js";
import { track } from "./record.js";

export const MUTATING = (m) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

/** Returns an error result if a mutating request does not look like it came from our own portal page. */
export function csrfCheck(req) {
  if (!MUTATING(req.method)) return null;
  if (req.headers.get("x-portal-request") !== "1") return fail("Missing X-Portal-Request header.", 403, { reasonCode: "CSRF" });
  const origin = req.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== (req.headers.get("x-forwarded-host") || req.headers.get("host"))) return fail("Cross-site request refused.", 403, { reasonCode: "CSRF" }); } catch { return fail("Cross-site request refused.", 403, { reasonCode: "CSRF" }); } }
  return null;
}

const limited = async (action, user, max, windowMs = 3600000) => { try { await checkRateLimit({ action, key: String(user._id), max, windowMs }); return null; } catch { return fail("You're doing that too often. Please wait a little and try again.", 429, { reasonCode: "RATE_LIMITED" }); } };

const notifView = (n) => ({ id: String(n._id), type: n.type, title: n.title, body: n.body, ticketId: n.ticketId ? String(n.ticketId) : null, createdAt: n.createdAt, read: !!n.readAt });

/**
 * result: { data } | { error, status } | { data, setCookie }.
 * `org` = { orgId, settings, portalSlug } from orgBySlug.
 */
export async function handlePortal({ method, path, query, body, req, org, ip }) {
  const orgId = String(org.orgId); const settings = org.settings; settings.portalSlug = org.portalSlug;
  const [a, b, c] = path;
  const G = method === "GET"; const P = method === "POST"; const U = method === "PUT" || method === "PATCH"; const D = method === "DELETE";
  const csrf = csrfCheck(req); if (csrf) return csrf;

  // ---------------------------------------------------------------- public
  if (a === "config" && G) {
    const user = await PA.getPortalUser({ req, orgId });
    return { name: settings.portalName || "Support", welcomeText: settings.welcomeText, signup: settings.signup, sso: settings.sso?.enabled ? { enabled: true, label: settings.sso.label } : { enabled: false }, features: { kb: settings.kb.enabled, ideas: settings.ideas.enabled, votingEnabled: settings.ideas.votingEnabled, chat: settings.ai.chatEnabled, csat: settings.csat.enabled }, ticketTypes: settings.customerSelectableTypes, categories: settings.categories, maxAttachmentBytes: settings.attachments.maxBytes, incidents: (await listIncidents({ orgId, activeOnly: true, forCustomer: true })).incidents, signedIn: !!user };
  }
  if (a === "auth" && b === "request" && P) return PA.requestLogin({ orgId, settings, email: body.email, ip, origin: null });
  if (a === "auth" && b === "verify" && P) {
    const r = await PA.verifyLogin({ orgId, settings, token: body.token });
    if (r.error) return r;
    return { data: { user: PA.publicUser(r.user) }, setCookie: PA.sessionCookie(r.sessionToken, r.maxAgeSeconds) };
  }
  if (a === "auth" && b === "logout" && P) { await PA.logout({ req, orgId }); return { data: { ok: true }, setCookie: PA.clearCookie() }; }

  const user = await PA.getPortalUser({ req, orgId });
  const level = user ? "CUSTOMERS" : "PUBLIC";

  if (a === "kb" && settings.kb.enabled) {
    if (b === "search" && G) return K.searchArticles({ orgId, q: query.q, level, limit: 10, actor: user ? { email: user.email, id: String(user._id) } : null });
    if (b === "categories" && G) return K.listCategories({ orgId, level });
    if (b === "articles" && c && G) { const art = await K.getArticle({ orgId, slug: c, level, actor: user ? { email: user.email } : null }); return art ? { article: art } : fail("Article not found.", 404); }
    if (b === "articles" && c && path[3] === "feedback" && P) { if (!user) return fail("Please sign in to leave feedback.", 401); return K.submitFeedback({ orgId, slug: c, level, user, helpful: body.helpful, kind: body.kind, comment: body.comment }); }
  }

  // ---------------------------------------------------------------- everything below needs a signed-in customer of THIS organization
  if (!user) return fail("Please sign in.", 401, { reasonCode: "UNAUTHENTICATED" });
  const who = { type: "customer", email: user.email, name: user.name, portalUserId: user._id };

  if (a === "me") { if (G) return { user: PA.publicUser(user) }; if (U) return PA.updateProfile({ orgId, user, name: body.name, timezone: body.timezone, prefs: body.prefs }); }

  if (a === "tickets") {
    if (!b) {
      if (G) return T.listTicketsForCustomer({ orgId, user, status: query.status || null, limit: Math.min(50, Number(query.limit) || 50), skip: Number(query.skip) || 0 });
      if (P) {
        const lim = await limited(`support:tickets:${orgId}`, user, settings.rate.ticketsPerHour); if (lim) return lim;
        const type = settings.customerSelectableTypes.includes(body.type) ? body.type : "Other";
        const r = await submitTicket({ orgId, settings, actor: who, requester: { email: user.email, name: user.name, portalUserId: user._id }, subject: body.subject, description: body.description, type, category: body.category, priority: body.priority, channel: "PORTAL", linkedInvoiceNumber: body.linkedInvoiceNumber || null, idempotencyKey: body.idempotencyKey ? `portal:${user._id}:${String(body.idempotencyKey).slice(0, 80)}` : null });
        if (r.error) return r;
        const view = await T.getTicketForCustomer({ orgId, user, ticketId: r.ticket._id, settings });
        return { ticket: view, duplicate: !!r.duplicate };
      }
    }
    if (b) {
      if (G && !c) { const v = await T.getTicketForCustomer({ orgId, user, ticketId: b, settings }); return v ? { ticket: v } : fail("Request not found.", 404); }
      // every action below first proves this customer may see the ticket; anything else is a 404
      const own = await T.getTicketForCustomer({ orgId, user, ticketId: b, settings });
      if (!own) return fail("Request not found.", 404);
      if (P && c === "reply") { const lim = await limited(`support:replies:${orgId}`, user, settings.rate.repliesPerHour); if (lim) return lim; const r = await M.addReply({ orgId, settings, ticketId: b, author: who, body: body.body }); return r.error ? r : { message: r.message, ticket: await T.getTicketForCustomer({ orgId, user, ticketId: b, settings }) }; }
      if (P && c === "solve") { const r = await customerSolve({ orgId, settings, ticketId: b, user, canAct: true }); return r.error ? r : { ticket: await T.getTicketForCustomer({ orgId, user, ticketId: b, settings }) }; }
      if (P && c === "reopen") { const r = await T.reopen({ orgId, settings, ticketId: b, actor: { type: "customer", email: user.email }, reason: toPlainText(body.reason, 300) || "Customer reopened" }); return r.error ? r : { ticket: await T.getTicketForCustomer({ orgId, user, ticketId: b, settings }) }; }
      if (P && c === "csat") return submitCsat({ orgId, settings, user, ticketId: b, score: body.score, comment: body.comment, helpful: body.helpful });
      if (P && c === "collaborators") { const t = await T.loadTicket(orgId, b); if (t.requester.email !== user.email) return fail("Only the person who made the request can share it.", 403); return T.addCollaborator({ orgId, ticketId: b, email: body.email, canReply: body.canReply === true, actor: { email: user.email }, byRequester: true }).then((r) => (r.error ? r : { ok: true })); }
      if (D && c === "collaborators") { const t = await T.loadTicket(orgId, b); if (t.requester.email !== user.email) return fail("Only the person who made the request can change sharing.", 403); return T.removeCollaborator({ orgId, ticketId: b, email: query.email || body.email, actor: { email: user.email } }).then((r) => (r.error ? r : { ok: true })); }
      if (P && c === "read") { return { ok: true }; }
    }
  }

  if (a === "invoices" && G) {
    if (!user.contactId) return { invoices: [], note: "Your account is not linked to a billing contact." };
    return { invoices: await C.invoicesForContact(orgId, user.contactId, 50) };
  }

  if (a === "ideas" && settings.ideas.enabled) {
    if (!b && G) return I.listIdeasForCustomer({ orgId, settings, user, scope: query.scope === "community" ? "community" : "mine" });
    if (!b && P) { const lim = await limited(`support:ideas:${orgId}`, user, 10); if (lim) return lim; return I.submitIdea({ orgId, settings, user, body }); }
    if (b === "check" && P) return { similar: await I.checkDuplicates({ orgId, user, title: toPlainText(body.title, 160), description: toPlainText(body.description, 4000) }) };
    if (b && c === "vote" && (P || D)) return I.voteIdea({ orgId, settings, user, ideaId: b, on: P });
  }

  if (a === "chat" && settings.ai.chatEnabled) {
    if (!b && P) return A.chat({ orgId, settings, user, sessionId: body.sessionId || null, message: body.message });
    if (b && G) return A.getChatSession({ orgId, user, sessionId: b });
    if (b && c === "handoff" && P) return A.handoffChat({ orgId, settings, user, sessionId: b, subject: body.subject || null, extra: body.extra || "" });
  }

  if (a === "notifications") {
    const { supportCustomerNotifications } = await getSupportCollections();
    const f = { orgId: toObjectId(orgId), $or: [{ portalUserId: user._id }, { portalUserId: null, email: user.email }] };
    if (G) { const rows = await supportCustomerNotifications.find(f).sort({ createdAt: -1 }).limit(50).toArray(); return { notifications: rows.map(notifView), unread: rows.filter((n) => !n.readAt).length }; }
    if (P && b === "read") { await supportCustomerNotifications.updateMany({ ...f, readAt: null }, { $set: { readAt: new Date().toISOString() } }); return { ok: true }; }
  }

  if (a === "suggest" && G) {
    // "before you submit": articles that may already answer the question (deterministic, from published knowledge)
    await track({ orgId, type: "portal.suggest", actor: user.email, data: {} });
    return settings.kb.enabled ? K.searchArticles({ orgId, q: toPlainText(query.q, 120), level: "CUSTOMERS", limit: 3, track: false }) : { results: [] };
  }

  return fail("Unknown portal endpoint.", 404);
}
