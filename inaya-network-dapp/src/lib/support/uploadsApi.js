// src/lib/support/uploadsApi.js
//
// Authorization for chunked uploads, shared by the portal, the agent console and the public API. The caller has
// already authenticated and resolved ctx:
//   portal: { kind: "portal", orgId, settings, user }
//   agent : { kind: "agent",  orgId, settings, membership, email }
//   api   : { kind: "api",    orgId, settings, customerEmail|null, keyId }
// A target the caller may not write to is a 404, identical to one that does not exist.

import { fail, normEmail } from "./common.js";
import { supportPerms } from "./access.js";
import { getTicketForAgent, getTicketForCustomer, loadTicket } from "./tickets.js";
import { customerMayReply } from "./messages.js";
import { initUpload, putChunk, completeUpload } from "./uploads.js";

const ownerOf = (ctx) => (ctx.kind === "portal" ? { kind: "portal", id: String(ctx.user._id), email: ctx.user.email } : ctx.kind === "agent" ? { kind: "agent", id: normEmail(ctx.email), email: ctx.email } : { kind: "api", id: ctx.keyId, email: ctx.customerEmail || `api:${ctx.keyId}` });

async function authorizeTarget(ctx, body) {
  if (body.ideaId) {
    if (ctx.kind !== "portal") return fail("Idea attachments can only be added by the customer who wrote the idea.", 403);
    return { type: "idea", id: String(body.ideaId), user: { _id: ctx.user._id, email: ctx.user.email, name: ctx.user.name } };
  }
  const ticketId = body.ticketId;
  if (!ticketId) return fail("ticketId or ideaId is required.");
  if (ctx.kind === "portal") {
    const view = await getTicketForCustomer({ orgId: ctx.orgId, user: ctx.user, ticketId, settings: ctx.settings });
    const t = view ? await loadTicket(ctx.orgId, ticketId) : null;
    if (!t || !customerMayReply(t, ctx.user.email)) return fail("Request not found.", 404);
    return { type: "ticket", id: t._id, messageId: body.messageId || null, visibility: "PUBLIC", uploader: { type: "customer", email: ctx.user.email } };
  }
  if (ctx.kind === "agent") {
    const internal = body.internal === true;
    if (!supportPerms(ctx.membership).has(internal ? "create_notes" : "reply_public")) return fail("You do not have permission to attach files here.", 403);
    const seen = await getTicketForAgent({ orgId: ctx.orgId, settings: ctx.settings, membership: ctx.membership, email: ctx.email, ticketId });
    if (seen.error) return seen;
    return { type: "ticket", id: seen.ticket.id, messageId: body.messageId || null, visibility: internal ? "INTERNAL" : "PUBLIC", uploader: { type: "agent", email: ctx.email } };
  }
  const t = await loadTicket(ctx.orgId, ticketId);
  if (!t) return fail("Ticket not found.", 404);
  const email = ctx.customerEmail || t.requester.email;
  const view = await getTicketForCustomer({ orgId: ctx.orgId, user: { email }, ticketId, settings: ctx.settings });
  if (!view) return fail("Ticket not found.", 404);
  return { type: "ticket", id: t._id, messageId: body.messageId || null, visibility: "PUBLIC", uploader: { type: "api", email } };
}

export async function upInit(ctx, body) {
  const target = await authorizeTarget(ctx, body || {});
  if (target.error) return target;
  return initUpload({ orgId: ctx.orgId, settings: ctx.settings, owner: ownerOf(ctx), target, filename: body.filename, size: Number(body.size), sha256: body.sha256 || null });
}
export const upChunk = (ctx, token, index, buffer) => putChunk({ orgId: ctx.orgId, owner: ownerOf(ctx), token, index, buffer });
export const upComplete = (ctx, token) => completeUpload({ orgId: ctx.orgId, settings: ctx.settings, owner: ownerOf(ctx), token });
