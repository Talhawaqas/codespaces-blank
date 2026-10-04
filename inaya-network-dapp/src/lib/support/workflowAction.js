// src/lib/support/workflowAction.js
//
// The WRITE side of Inaya's native support node for Workflow Automations (the read side is data.inaya_support_tickets).
//   action.support_ticket  operation "create" -> opens a ticket in the org's own Customer Support module;
//                          operation "note"   -> adds an INTERNAL note to an existing ticket (never a customer-visible reply).
// It acts as the executing identity: the same support permissions the agent console enforces apply on every run. It cannot
// reply to a customer, change a status, delete anything or touch billing; those stay with people.

import { canSupport } from "./access.js";
import { createTicket, loadTicketByNumber, loadTicket } from "./tickets.js";
import { addNote } from "./messages.js";
import { getSettings } from "./settings.js";

export const SUPPORT_TICKET_OPERATIONS = ["create", "note"];
const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];

const refuse = (message, code) => Object.assign(new Error(message), { retryable: false, code });

/** `cfg` already has its {{ }} templates rendered. `idempotencyKey` makes a retried run reuse the ticket it already opened. */
export async function runSupportTicketAction({ orgId, membership, email, cfg, idempotencyKey }) {
  const settings = await getSettings(orgId);
  if (cfg.operation === "note") {
    if (!canSupport(membership, "create_notes")) throw refuse("The executing identity may not add internal notes.", "PERMISSION_DENIED");
    const ticket = cfg.ticketNumber ? await loadTicketByNumber(orgId, cfg.ticketNumber) : cfg.ticketId ? await loadTicket(orgId, cfg.ticketId) : null;
    if (!ticket) throw refuse("That ticket was not found.", "ENTITY_NOT_FOUND");
    const r = await addNote({ orgId, settings, ticketId: String(ticket._id), author: { email, name: "Workflow Automation" }, body: cfg.body });
    if (r?.error) throw refuse(r.error, "SUPPORT_REFUSED");
    return { operation: "note", ticketId: String(ticket._id), number: ticket.number, noteAdded: true };
  }
  if (!canSupport(membership, "view_tickets")) throw refuse("The executing identity has no Customer Support access.", "PERMISSION_DENIED");
  const priority = cfg.priority ? String(cfg.priority).toUpperCase() : undefined;
  const r = await createTicket({
    orgId, settings,
    actor: { type: "agent", email, staff: true },
    requester: { email: cfg.requesterEmail, name: cfg.requesterName || null },
    subject: cfg.subject, description: cfg.description,
    type: cfg.type || "Other", category: cfg.category || "General",
    priority: PRIORITIES.includes(priority) ? priority : undefined,
    channel: "API", idempotencyKey,
    tags: Array.isArray(cfg.tags) ? cfg.tags.slice(0, 10).map(String) : [],
  });
  if (r?.error) throw refuse(r.error, "SUPPORT_REFUSED");
  const t = r.ticket;
  return { operation: "create", ticketId: String(t._id), number: t.number, status: t.status, priority: t.priority, created: true };
}
