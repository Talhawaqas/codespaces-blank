// src/lib/engagement/workflowAction.js
//
// The write side of the Appointments & Campaigns node for Workflow Automations:
//   action.marketing_enroll -> puts one person into a follow-up email sequence.
// It acts as the workflow's executing identity: that person needs the marketing editor/manager role (owner/admin
// qualify), the org needs the Business or Enterprise plan, and the sequence must belong to the org. Enrolling never
// sends anything by itself: emails go out only while the sequence is approved and ACTIVE, and suppressed addresses
// (unsubscribed, bounced, complained) are skipped.

import { canEditCampaigns } from "../orgGates.js";
import { engagementAccess, normEmail, isEmail } from "./store.js";
import { enrollMany } from "./sequences.js";

const refuse = (message, code) => Object.assign(new Error(message), { retryable: false, code });

export async function runMarketingEnrollAction({ orgId, membership, cfg }) {
  if (!canEditCampaigns(membership)) throw refuse("The executing identity needs the marketing editor or manager role.", "PERMISSION_DENIED");
  const gate = await engagementAccess(String(orgId), "campaigns");
  if (gate) throw refuse(gate.error, "PLAN_REQUIRED");
  const email = normEmail(cfg.email);
  if (!isEmail(email)) throw refuse(`"${String(cfg.email || "").slice(0, 80)}" is not an email address.`, "INVALID_INPUT");
  const r = await enrollMany({ orgId: String(orgId), sequenceId: cfg.sequenceId, people: [{ email, name: cfg.name || "", company: cfg.company || "" }], source: "workflow" });
  if (r?.error) throw refuse(r.error, "ENTITY_NOT_FOUND");
  return { email, sequenceId: String(cfg.sequenceId), enrolled: r.enrolled === 1, skipped: r.skipped === 1, sequenceStatus: r.sequenceStatus };
}
