// src/lib/support/csat.js
//
// SOW §24: customer satisfaction. One response per ticket, only from the requester, only after resolution.
// Metrics derived from these rows are reported only when responses exist (analytics.js never invents a score).

import { toObjectId } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { fail, nowIso, toPlainText, normEmail } from "./common.js";
import { audit, emit, link } from "./record.js";
import { getTicketForCustomer, loadTicket } from "./tickets.js";

export async function submitCsat({ orgId, settings, user, ticketId, score, comment = "", helpful = null }) {
  if (!settings.csat.enabled) return fail("Feedback is not enabled.", 403);
  const s = Number(score);
  if (!Number.isInteger(s) || s < 1 || s > 5) return fail("score must be a whole number from 1 to 5.");
  const view = await getTicketForCustomer({ orgId, user, ticketId, settings });
  if (!view) return fail("Request not found.", 404);
  if (!["SOLVED", "CLOSED"].includes(view.status)) return fail("You can rate a request once it has been solved.", 409);
  const t = await loadTicket(orgId, ticketId);
  if (t.requester.email !== normEmail(user.email)) return fail("Only the person who made the request can rate it.", 403);
  const { supportCsat } = await getSupportCollections();
  const doc = { orgId: toObjectId(orgId), ticketId: t._id, score: s, comment: toPlainText(comment, 1000), helpful: typeof helpful === "boolean" ? helpful : null, portalUserId: user._id, assigneeEmail: t.assigneeEmail || null, queueId: t.queueId || null, createdAt: nowIso() };
  try { await supportCsat.insertOne(doc); } catch (err) { if (err?.code === 11000) return fail("You already rated this request.", 409); throw err; }
  await audit({ orgId, ticketId: t._id, action: "TICKET_CSAT_RECEIVED", actorEmail: user.email, metadata: { score: s, number: t.number } });
  await emit({ orgId, type: "ticket.csat_received", ticket: t, actor: user.email, data: { score: s } });
  link({ orgId, ticketId: t._id, type: "PROVEN_BY", targetType: "SUPPORT_CSAT", targetId: t._id, note: `customer confirmed: ${s}/5` });
  return { recorded: true };
}
