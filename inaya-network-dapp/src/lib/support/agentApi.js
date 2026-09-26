// src/lib/support/agentApi.js
//
// The agent / administrator API (used by the Business Workspace console), as one dispatcher so every endpoint
// applies the same rules in the same order: the caller is an authenticated MEMBER of the organization (checked by
// the route wrapper against the caller's own membership), each action needs a named support permission, and every
// ticket-scoped action first proves the agent may see THAT ticket (queue / team visibility) — a ticket they cannot see
// is a 404, identical to one that does not exist.

import { fail, normEmail } from "./common.js";
import { supportPerms, isSupportStaff } from "./access.js";
import { getSettings, updateSettings, publicSettings, rotateInboundSecret, setSsoClientSecret } from "./settings.js";
import { testSso } from "./sso.js";
import * as Q from "./queues.js";
import * as T from "./tickets.js";
import * as M from "./messages.js";
import * as C from "./customers.js";
import * as K from "./kb.js";
import * as I from "./ideas.js";
import * as W from "./webhooks.js";
import * as IN from "./inbound.js";
import * as A from "./ai.js";
import * as AK from "./apiKeys.js";
import * as MAC from "./macros.js";
import * as INC from "./incidents.js";
import { getAnalytics } from "./analytics.js";
import { submitTicket } from "./flows.js";
import { getSupportCollections } from "./db.js";
import { toObjectId } from "../orgs.js";
import { audit, emit } from "./record.js";
import { addAttachment } from "./attachments.js";
import { supportAddressOf, APP_URL, emailBody } from "./notify.js";
import { configuredEngines } from "./scanner.js";
import { sendEmail } from "../email.js";

const deny = (perm) => fail(`You do not have the ${perm} permission for support.`, 403, { reasonCode: "FORBIDDEN" });

export async function handleAgent({ method, path, query, body, orgId, membership, email }) {
  const perms = supportPerms(membership);
  const need = (p) => (perms.has(p) ? null : deny(p));
  const actor = { type: "agent", email, staff: true };
  const settings = await getSettings(orgId);
  const [a, b, c, d] = path;
  const G = method === "GET"; const P = method === "POST"; const U = method === "PUT" || method === "PATCH"; const D = method === "DELETE";

  // ------------------------------------------------------------------ who am I
  if (a === "me" && G) return { email, isStaff: isSupportStaff(membership), permissions: [...perms], portalSlug: settings.portalSlug, portalEnabled: settings.portalEnabled, statuses: (await import("./common.js")).STATUSES, ticketTypes: settings.ticketTypes, categories: settings.categories };
  if (!isSupportStaff(membership) && !(perms.has("admin_settings"))) return deny("view_tickets");

  // ------------------------------------------------------------------ settings
  if (a === "settings") {
    if (G && b === "status") return need("admin_settings") || systemStatus(settings);
    if (P && b === "test-email") return need("admin_settings") || sendTestEmail({ settings, email });
    if (G) return { settings: publicSettings(settings) };
    if (U) return need("admin_settings") || updateSettingsAndAudit({ orgId, body, email });
    if (P && b === "inbound-secret") return need("admin_settings") || rotateInboundSecret({ orgId, actorEmail: email });
    if (P && b === "sso-secret") return need("admin_settings") || (async () => { const r = await setSsoClientSecret({ orgId, secret: body.secret, actorEmail: email }); if (!r.error) await audit({ orgId, action: "SUPPORT_SSO_SECRET_SET", actorEmail: email, metadata: {} }); return r; })();
    if (P && b === "sso-test") return need("admin_settings") || (settings.portalSlug ? testSso({ orgId, settings, slug: settings.portalSlug }) : fail("Choose a portal address first."));
  }
  // ------------------------------------------------------------------ queues, teams, agents, policies
  if (a === "queues") { if (G) return Q.listQueues({ orgId }); if (P) return need("admin_queues") || Q.upsertQueue({ orgId, body }); if (U && b) return need("admin_queues") || Q.upsertQueue({ orgId, queueId: b, body }); }
  if (a === "teams") { if (G) return Q.listTeams({ orgId }); if (P) return need("admin_queues") || Q.upsertTeam({ orgId, body }); if (U && b) return need("admin_queues") || Q.upsertTeam({ orgId, teamId: b, body }); }
  if (a === "sla-policies") { if (G) return Q.listPolicies({ orgId }); if (P) return need("admin_sla") || Q.upsertPolicy({ orgId, body }); if (U && b) return need("admin_sla") || Q.upsertPolicy({ orgId, policyId: b, body }); }
  if (a === "agents") {
    if (G && !b) return Q.listAgents({ orgId });
    if (U && b && c === "role") return need("manage_agents") || Q.setMemberSupport({ orgId, email: decodeURIComponent(b), supportRole: body.supportRole, supportPermissions: body.supportPermissions });
    if (U && b && c === "profile") return need("manage_agents") || Q.setAgentProfile({ orgId, email: decodeURIComponent(b), skills: body.skills, available: body.available, maxOpen: body.maxOpen });
  }

  // ------------------------------------------------------------------ tickets
  if (a === "tickets") {
    if (!b) {
      if (G) return need("view_tickets") || T.listTickets({ orgId, settings, membership, email, view: query.view || "all_open", queueId: query.queueId, status: query.status, assignee: query.assignee, priority: query.priority, q: query.q, limit: Number(query.limit) || 50, skip: Number(query.skip) || 0 });
      if (P) {
        const r = await submitTicket({ orgId, settings, actor, requester: { email: body.requesterEmail, name: body.requesterName }, subject: body.subject, description: body.description, type: body.type, category: body.category, priority: body.priority, channel: "AGENT", assigneeEmail: body.assigneeEmail || null, queueId: body.queueId || null, tags: body.tags, linkedInvoiceNumber: body.linkedInvoiceNumber, idempotencyKey: body.idempotencyKey || null });
        return r.error ? r : { ticket: T.agentSummary(r.ticket, settings, Date.now(), normEmail(email)), duplicate: !!r.duplicate };
      }
    }
    if (b) {
      const ticketId = b;
      if (!G || !c) {
        // every ticket-scoped mutation: the agent must be able to see this ticket
        const seen = await T.getTicketForAgent({ orgId, settings, membership, email, ticketId });
        if (seen.error) return seen;
      }
      if (G && !c) return need("view_tickets") || T.getTicketForAgent({ orgId, settings, membership, email, ticketId });
      if (G && c === "related") return need("view_tickets") || { related: await T.relatedTickets({ orgId, ticketId }) };
      if (P && c === "reply") return need("reply_public") || M.addReply({ orgId, settings, ticketId, author: { type: "agent", email, name: body.authorName }, body: body.body, setStatus: body.setStatus || null, aiGenerated: body.aiGenerated === true });
      if (P && c === "note") return need("create_notes") || M.addNote({ orgId, settings, ticketId, author: { email }, body: body.body });
      if (P && c === "status") return need("reply_public") || T.transition({ orgId, settings, ticketId, to: body.status, actor, reason: body.reason || null, allowReopen: true });
      if (P && c === "reopen") return need("reply_public") || T.reopen({ orgId, settings, ticketId, actor, reason: body.reason || "Reopened by an agent" });
      if (P && c === "assign") return need("assign_tickets") || T.assign({ orgId, settings, ticketId, assigneeEmail: body.assigneeEmail === undefined ? undefined : body.assigneeEmail, queueId: body.queueId, teamId: body.teamId, actor });
      if (P && c === "priority") return need("change_priority") || T.setPriority({ orgId, settings, ticketId, priority: body.priority, actor });
      if (P && c === "tags") return need("reply_public") || T.setTags({ orgId, ticketId, add: body.add, remove: body.remove, actor });
      if (P && c === "follow") return T.follow({ orgId, ticketId, email, on: body.on !== false });
      if (P && c === "read") { await T.markRead({ orgId, ticketId, email }); return { ok: true }; }
      if (P && c === "sla-policy") return need("change_sla") || T.setSlaPolicy({ orgId, settings, ticketId, policyId: body.policyId, actor });
      if (P && c === "merge") return need("merge_tickets") || T.merge({ orgId, settings, sourceId: ticketId, targetId: body.targetId, actor });
      if (P && c === "relate") return need("assign_tickets") || T.relate({ orgId, fromId: ticketId, toId: body.toId, type: body.type, actor });
      if (P && c === "collaborators") return need("reply_public") || T.addCollaborator({ orgId, ticketId, email: body.email, canReply: body.canReply === true, actor });
      if (D && c === "collaborators") return need("reply_public") || T.removeCollaborator({ orgId, ticketId, email: query.email || body.email, actor });
      if (P && c === "ai-draft") return need("use_ai") || A.draftReply({ orgId, settings, ticketId, actor: { email } });
      if (P && c === "kb-draft") return need("manage_kb") || A.draftArticleFromTicket({ orgId, ticketId, actor: { email } });
      if (P && c === "triage") { return need("use_ai") || (await resetTriage(orgId, ticketId), A.triageTicket({ orgId, settings, ticketId })); }
      if (P && c === "macro") { const t = await T.loadTicket(orgId, ticketId); const macros = (await MAC.listMacros({ orgId })).macros; const m = macros.find((x) => x.id === body.macroId); return m ? { text: MAC.renderMacro(m.body, { ticket: t, agent: { email } }), setStatus: m.setStatus, addTags: m.addTags } : fail("Macro not found.", 404); }
    }
  }

  // ------------------------------------------------------------------ customers
  if (a === "customers" && b) {
    const em = decodeURIComponent(b);
    if (G) return need("view_tickets") || { customer: await C.customerContext({ orgId, email: em, includeInvoices: perms.has("view_invoices") }) };
    if (U && c === "profile") return need("manage_agents") || C.upsertProfile({ orgId, email: em, tier: body.tier, accountOwnerEmail: body.accountOwnerEmail, timezone: body.timezone, notes: body.notes, actorEmail: email, tiers: settings.customerTiers });
  }

  // ------------------------------------------------------------------ knowledge base
  if (a === "kb") {
    if (b === "gaps" && G) return need("manage_kb") || K.detectGaps({ orgId, days: Number(query.days) || 30 });
    if (!b) { if (G) return need("view_tickets") || K.listArticlesForAgents({ orgId, status: query.status || null, q: query.q || null }); if (P) return need("manage_kb") || K.createArticle({ orgId, actor: { email }, body }); }
    if (b && !c) { if (G) return need("view_tickets") || K.getArticleForAgents({ orgId, articleId: b }); if (U) return need("manage_kb") || K.editArticle({ orgId, articleId: b, actor: { email }, body }); }
    if (b && c === "submit" && P) return need("manage_kb") || K.submitForReview({ orgId, articleId: b, actor: { email } });
    if (b && c === "review" && P) return need("manage_kb") || K.reviewArticle({ orgId, articleId: b, actor: { email }, membership, decision: body.decision, note: body.note });
    if (b && c === "archive" && P) return need("manage_kb") || K.archiveArticle({ orgId, articleId: b, actor: { email }, restore: body.restore === true });
  }
  // ------------------------------------------------------------------ ideas
  if (a === "ideas") { if (G) return need("manage_ideas") || I.listIdeas({ orgId, status: query.status || null }); if (U && b) return need("manage_ideas") || I.updateIdeaStatus({ orgId, settings, ideaId: b, status: body.status, publicNote: body.publicNote ?? null, duplicateOfId: body.duplicateOfId || null, actor: { email } }); }
  // ------------------------------------------------------------------ analytics, events, search
  if (a === "analytics" && G) return need("view_tickets") || { analytics: await getAnalytics({ orgId, settings, days: Number(query.days) || 30 }) };
  if (a === "events" && G) {
    const err = need("view_tickets"); if (err) return err;
    const { supportEvents } = await getSupportCollections();
    const rows = await supportEvents.find({ orgId: toObjectId(orgId), analytics: { $ne: true } }).sort({ createdAt: -1 }).limit(Math.min(200, Number(query.limit) || 50)).toArray();
    return { events: rows.map((e) => ({ id: String(e._id), type: e.type, at: e.createdAt, actor: e.actor, ticketId: e.ticketId ? String(e.ticketId) : null, data: e.data })) };
  }
  if (a === "search" && G) {
    const err = need("view_tickets"); if (err) return err;
    const q = String(query.q || "").trim();
    if (q.length < 2) return { tickets: [], articles: [], customers: [] };
    const [tk, kb] = await Promise.all([T.listTickets({ orgId, settings, membership, email, view: "all", q, limit: 8 }), K.searchArticles({ orgId, q, level: "INTERNAL", limit: 5, track: false })]);
    return { tickets: tk.tickets || [], articles: kb.results || [] };
  }
  // ------------------------------------------------------------------ inbound email quarantine
  if (a === "inbound") {
    if (G) return need("admin_settings") || IN.listInbound({ orgId, status: query.status || "QUARANTINED" });
    if (P && b && c === "accept") return need("admin_settings") || IN.acceptInbound({ orgId, settings, inboundId: b, actor: { email }, appendToTicketId: body.appendToTicketId || null });
    if (P && b && c === "dismiss") return need("admin_settings") || IN.dismissInbound({ orgId, inboundId: b, actor: { email } });
  }
  // ------------------------------------------------------------------ webhooks, API keys
  if (a === "webhooks") {
    if (G && !b) return need("admin_settings") || W.listWebhooks({ orgId });
    if (P && !b) return need("admin_settings") || W.createWebhook({ orgId, url: body.url, events: body.events, description: body.description, actorEmail: email });
    if (U && b) return need("admin_settings") || W.setWebhookActive({ orgId, webhookId: b, active: body.active !== false });
    if (D && b) return need("admin_settings") || W.deleteWebhook({ orgId, webhookId: b });
    if (G && b === "deliveries") return need("admin_settings") || W.listDeliveries({ orgId, webhookId: query.webhookId || null, status: query.status || null });
    if (P && b === "deliveries" && c && d === "redeliver") return need("admin_settings") || W.redeliver({ orgId, deliveryId: c });
  }
  if (a === "api-keys") {
    if (G) return need("admin_settings") || AK.listSupportApiKeys({ orgId });
    if (P) return need("admin_settings") || AK.createSupportApiKey({ orgId, label: body.label, scopes: body.scopes, expiresInDays: body.expiresInDays, customerEmail: body.customerEmail || null, actorEmail: email });
    if (D && b) return need("admin_settings") || AK.revokeSupportApiKey({ orgId, apiKeyId: b, actorEmail: email });
    if (G && b === "scopes") return { scopes: AK.API_SCOPES };
  }
  // ------------------------------------------------------------------ macros, views, incidents
  if (a === "macros") { if (G) return MAC.listMacros({ orgId }); if (P) return need("admin_queues") || MAC.upsertMacro({ orgId, body, actor: { email } }); if (U && b) return need("admin_queues") || MAC.upsertMacro({ orgId, macroId: b, body, actor: { email } }); if (D && b) return need("admin_queues") || MAC.deleteMacro({ orgId, macroId: b }); }
  if (a === "views") { if (G) return MAC.listViews({ orgId, email }); if (P) return MAC.saveView({ orgId, email, body }); if (D && b) return MAC.deleteView({ orgId, email, viewId: b }); }
  if (a === "incidents") { if (G) return INC.listIncidents({ orgId }); if (P && !b) return need("admin_settings") || INC.createIncident({ orgId, title: body.title, message: body.message, severity: body.severity, customerVisible: body.customerVisible !== false, actor: { email } }); if (U && b) return need("admin_settings") || INC.updateIncident({ orgId, incidentId: b, status: body.status, message: body.message, actor: { email } }); }

  return fail("Unknown support endpoint.", 404);
}

async function updateSettingsAndAudit({ orgId, body, email }) {
  const r = await updateSettings({ orgId, patch: body, actorEmail: email });
  if (r.error) return r;
  await audit({ orgId, action: "SUPPORT_SETTINGS_CHANGED", actorEmail: email, metadata: { keys: Object.keys(body || {}) } });
  await emit({ orgId, type: "settings.changed", data: { keys: Object.keys(body || {}) }, actor: email });
  return { settings: publicSettings(r.settings) };
}

async function resetTriage(orgId, ticketId) {
  const { supportTickets } = await getSupportCollections();
  await supportTickets.updateOne({ _id: toObjectId(ticketId), orgId: toObjectId(orgId) }, { $set: { "aiTriage.state": "PENDING", "aiTriage.attempts": 0, "aiTriage.nextAttemptAt": null } });
}

/** Multipart upload used by agents (route handles parsing and the byte limit). */
export async function agentUpload({ orgId, membership, email, ticketId, file, internal, messageId = null }) {
  const settings = await getSettings(orgId);
  if (!supportPerms(membership).has(internal ? "create_notes" : "reply_public")) return deny(internal ? "create_notes" : "reply_public");
  const seen = await T.getTicketForAgent({ orgId, settings, membership, email, ticketId });
  if (seen.error) return seen;
  return addAttachment({ orgId, settings, ticketId, messageId, file, uploader: { type: "agent", email }, visibility: internal ? "INTERNAL" : "PUBLIC" });
}

/** What the platform can actually do right now, for the administrator (never any secret). */
function systemStatus(settings) {
  const engines = configuredEngines();
  return {
    portalUrl: settings.portalSlug ? `${APP_URL()}/portal/${settings.portalSlug}` : null,
    email: {
      outbound: { configured: !!process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM || null },
      inbound: { resendWebhookConfigured: !!process.env.RESEND_WEBHOOK_SECRET, inboundDomain: process.env.SUPPORT_INBOUND_DOMAIN || null, replyAddress: supportAddressOf(settings), organizationRelayEnabled: !!settings._hasInboundSecret },
    },
    scanning: { builtIn: true, engines, mode: settings.scan?.mode || "static", note: engines.length ? `Files are inspected by the built-in scanner and by ${engines.join(" and ")}.` : "Files are inspected by the built-in scanner only (archives, macros, PDF active content, executables). No antivirus engine is configured on this platform." },
    attachments: { maxBytes: settings.attachments.maxBytes },
    sso: { enabled: !!settings.sso?.enabled, clientSecretSet: !!settings._hasSsoSecret },
  };
}

async function sendTestEmail({ settings, email }) {
  const body = emailBody({ heading: "Support email test", message: "If you can read this, outbound support email (sign-in links and ticket updates) is working for your workspace.", linkUrl: settings.portalSlug ? `${APP_URL()}/portal/${settings.portalSlug}` : APP_URL(), linkLabel: "Open the portal" });
  const r = await sendEmail({ to: email, subject: "Support email test", html: body.html, text: body.text });
  return r.sent ? { sent: true, to: email } : fail(r.reason === "not_configured" ? "Outbound email is not configured on this server (RESEND_API_KEY)." : `The email provider refused the message (${r.reason}).`, 502);
}
