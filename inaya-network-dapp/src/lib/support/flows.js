// src/lib/support/flows.js
//
// Cross-module flows used by every entry point (portal, agent console, public API, inbound email), so each path
// creates and updates tickets the same way.

import { fail } from "./common.js";
import { createTicket, transition } from "./tickets.js";
import { triageTicket } from "./ai.js";

const TRIAGE_BUDGET_MS = 12000;

/**
 * Creates a ticket, then tries AI triage within a short budget. The ticket exists and is routed by the
 * deterministic rules BEFORE the model is asked anything, so a slow or failing model can only delay the
 * suggestion: it stays PENDING and the scheduler retries it (SOW §15, §62).
 */
export async function submitTicket(input) {
  const r = await createTicket(input);
  if (r.error || r.duplicate) return r;
  if (r.ticket.aiTriage?.state === "PENDING") {
    try {
      await Promise.race([triageTicket({ orgId: input.orgId, settings: input.settings, ticketId: r.ticket._id }), new Promise((res) => setTimeout(res, TRIAGE_BUDGET_MS))]);
    } catch (err) { console.error("support inline triage failed (ticket kept):", err.message); }
  }
  return r;
}

/** A customer confirms their request is resolved. */
export async function customerSolve({ orgId, settings, ticketId, user, canAct }) {
  if (!canAct) return fail("Request not found.", 404);
  return transition({ orgId, settings, ticketId, to: "SOLVED", actor: { type: "customer", email: user.email }, reason: "Customer confirmed it is resolved" });
}
