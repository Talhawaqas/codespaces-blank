// src/lib/support/db.js
//
// Customer Portal & Customer Service SOW: collections and indexes. Kept in the support module (not in
// orgs.js) so this feature touches the shared org layer as little as possible. Every collection carries
// orgId and every query in this module filters on it: there is no code path that reads across
// organizations.

import { connectToDatabase } from "../mongodb.js";

export const SUPPORT_COLLECTIONS = [
  "supportSettings", "supportCounters", "supportTickets", "supportMessages", "supportEvents", "supportQueues", "supportTeams", "supportAgents",
  "supportSlaPolicies", "supportSlaEvents", "supportRelations", "supportInbound", "supportCustomerProfiles", "supportPortalUsers",
  "supportPortalLoginTokens", "supportPortalSessions", "supportKbArticles", "supportKbVersions", "supportKbFeedback", "supportIdeas",
  "supportChatSessions", "supportCsat", "supportWebhooks", "supportWebhookDeliveries", "supportViews", "supportMacros", "supportAttachments",
  "supportCustomerNotifications", "supportRequests", "supportIncidents", "supportUploads", "supportUploadChunks", "supportSsoStates",
];

export async function getSupportCollections() {
  const { db } = await connectToDatabase();
  const out = { db };
  for (const n of SUPPORT_COLLECTIONS) out[n] = db.collection(n);
  return out;
}

let ensured = false;
export async function ensureSupportIndexes() {
  if (ensured) return;
  const c = await getSupportCollections();
  await Promise.all([
    c.supportSettings.createIndex({ orgId: 1 }, { unique: true }),
    c.supportSettings.createIndex({ portalSlug: 1 }, { unique: true, partialFilterExpression: { portalSlug: { $type: "string" } } }),
    c.supportTickets.createIndex({ orgId: 1, seq: 1 }, { unique: true }),
    c.supportTickets.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    c.supportTickets.createIndex({ orgId: 1, status: 1, updatedAt: -1 }),
    c.supportTickets.createIndex({ orgId: 1, queueId: 1, status: 1 }),
    c.supportTickets.createIndex({ orgId: 1, assigneeEmail: 1, status: 1 }),
    c.supportTickets.createIndex({ orgId: 1, "requester.email": 1, createdAt: -1 }),
    c.supportTickets.createIndex({ orgId: 1, "requester.portalUserId": 1, createdAt: -1 }),
    c.supportTickets.createIndex({ orgId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }),
    c.supportTickets.createIndex({ status: 1, "sla.nextCheckAt": 1 }),
    c.supportTickets.createIndex({ subject: "text", description: "text", tags: "text" }, { name: "support_ticket_text" }),
    c.supportMessages.createIndex({ orgId: 1, ticketId: 1, createdAt: 1 }),
    c.supportMessages.createIndex({ orgId: 1, messageIdHeader: 1 }, { partialFilterExpression: { messageIdHeader: { $type: "string" } } }),
    c.supportMessages.createIndex({ body: "text" }, { name: "support_message_text" }),
    c.supportEvents.createIndex({ orgId: 1, createdAt: -1 }),
    c.supportEvents.createIndex({ orgId: 1, type: 1, createdAt: -1 }),
    c.supportEvents.createIndex({ orgId: 1, ticketId: 1, createdAt: 1 }),
    c.supportQueues.createIndex({ orgId: 1, active: 1, order: 1 }),
    c.supportTeams.createIndex({ orgId: 1, name: 1 }, { unique: true }),
    c.supportAgents.createIndex({ orgId: 1, email: 1 }, { unique: true }),
    c.supportSlaPolicies.createIndex({ orgId: 1, active: 1 }),
    c.supportSlaEvents.createIndex({ orgId: 1, key: 1 }, { unique: true }),
    c.supportRelations.createIndex({ orgId: 1, fromTicketId: 1 }),
    c.supportRelations.createIndex({ orgId: 1, toTicketId: 1 }),
    c.supportInbound.createIndex({ orgId: 1, messageId: 1 }, { unique: true }),
    c.supportInbound.createIndex({ orgId: 1, status: 1, createdAt: -1 }),
    c.supportCustomerProfiles.createIndex({ orgId: 1, email: 1 }, { unique: true }),
    c.supportPortalUsers.createIndex({ orgId: 1, email: 1 }, { unique: true }),
    c.supportPortalLoginTokens.createIndex({ tokenHash: 1 }, { unique: true }),
    c.supportPortalLoginTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.supportPortalSessions.createIndex({ tokenHash: 1 }, { unique: true }),
    c.supportPortalSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.supportKbArticles.createIndex({ orgId: 1, slug: 1 }, { unique: true }),
    c.supportKbArticles.createIndex({ orgId: 1, status: 1, audience: 1 }),
    c.supportKbArticles.createIndex({ title: "text", body: "text", summary: "text", tags: "text" }, { name: "support_kb_text" }),
    c.supportKbVersions.createIndex({ orgId: 1, articleId: 1, version: 1 }, { unique: true }),
    c.supportKbFeedback.createIndex({ orgId: 1, articleId: 1, createdAt: -1 }),
    c.supportIdeas.createIndex({ orgId: 1, number: 1 }, { unique: true }),
    c.supportIdeas.createIndex({ orgId: 1, status: 1, createdAt: -1 }),
    c.supportChatSessions.createIndex({ orgId: 1, portalUserId: 1, createdAt: -1 }),
    c.supportCsat.createIndex({ orgId: 1, ticketId: 1 }, { unique: true }),
    c.supportWebhooks.createIndex({ orgId: 1, active: 1 }),
    c.supportWebhookDeliveries.createIndex({ orgId: 1, webhookId: 1, eventId: 1 }, { unique: true }),
    c.supportWebhookDeliveries.createIndex({ status: 1, nextAttemptAt: 1 }),
    c.supportViews.createIndex({ orgId: 1, ownerEmail: 1 }),
    c.supportMacros.createIndex({ orgId: 1, name: 1 }, { unique: true }),
    c.supportAttachments.createIndex({ orgId: 1, ticketId: 1 }),
    c.supportCustomerNotifications.createIndex({ orgId: 1, portalUserId: 1, createdAt: -1 }),
    c.supportCustomerNotifications.createIndex({ orgId: 1, dedupeKey: 1 }, { unique: true }),
    c.supportRequests.createIndex({ orgId: 1, key: 1 }, { unique: true }),
    c.supportRequests.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }),
    c.supportIncidents.createIndex({ orgId: 1, status: 1, updatedAt: -1 }),
    c.supportUploads.createIndex({ orgId: 1, tokenHash: 1 }, { unique: true }),
    c.supportUploads.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.supportUploadChunks.createIndex({ uploadId: 1, index: 1 }, { unique: true }),
    c.supportUploadChunks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.supportSsoStates.createIndex({ stateHash: 1 }, { unique: true }),
    c.supportSsoStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  ensured = true;
}
