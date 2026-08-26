// src/lib/deal-workflow.js
//
// Sales pipeline state machine for CRM deals — same exact pattern as
// task-workflow.js (state enum + transition table + one atomic
// findOneAndUpdate per transition, 409 on race/replay). "advance"/
// "regress" step linearly through the open pipeline (NEW -> QUALIFIED ->
// PROPOSAL -> NEGOTIATION); "win"/"lose" close a deal from ANY open
// stage (a deal can be won or lost the moment it's created, not only
// after working through every intermediate stage); "reopen" returns a
// closed deal to NEW rather than back to whatever stage it was at —
// simpler than reconstructing pipeline history, and a reopened deal
// re-earning its way through the pipeline is the more honest signal
// anyway.
//
// ACCESS: canAccessDepartment(membership, deal.departmentId) — same
// department-level model Tasks uses. No record-level deal permission
// grant in this pass; if sales-data sensitivity beyond department scope
// becomes a real requirement, add a deal_permissions table mirroring
// document_permissions rather than retrofitting this file.

import { getOrgCollections, canAccessDepartment, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const DEAL_STAGES = ["NEW", "QUALIFIED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"];
const OPEN_PIPELINE = ["NEW", "QUALIFIED", "PROPOSAL", "NEGOTIATION"];

function nextOpenStage(stage) {
  const i = OPEN_PIPELINE.indexOf(stage);
  return i >= 0 && i < OPEN_PIPELINE.length - 1 ? OPEN_PIPELINE[i + 1] : null;
}
function prevOpenStage(stage) {
  const i = OPEN_PIPELINE.indexOf(stage);
  return i > 0 ? OPEN_PIPELINE[i - 1] : null;
}

/** The single enforcement point for every deal stage change. Returns
 *  { deal } on success, or { error, status } on failure. `advance`/
 *  `regress` compute their target stage from the deal's CURRENT stage at
 *  transition time (not a fixed {from,to} pair), so the transition table
 *  below only carries static actions — the atomic filter still pins
 *  `status: deal.status` read just before the update, giving the same
 *  replay/race safety as a fixed-target transition. */
export async function transitionDeal({ orgId, dealId, action, membership, actorEmail, note }) {
  if (!["advance", "regress", "win", "lose", "reopen"].includes(action)) {
    return { error: `Unknown action "${action}".`, status: 400 };
  }

  const { crmDeals } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const dealObjectId = toObjectId(dealId);

  const deal = await crmDeals.findOne({ _id: dealObjectId, orgId: orgObjectId, deletedAt: null });
  if (!deal) return { error: "Deal not found.", status: 404 };
  if (!canAccessDepartment(membership, deal.departmentId)) {
    return { error: "You don't have permission to do that.", status: 403 };
  }

  let to;
  let activityAction;
  if (action === "advance") {
    to = nextOpenStage(deal.status);
    if (!to) return { error: `"${deal.status}" has no next pipeline stage — use "win" or "lose" to close it.`, status: 409 };
    activityAction = "DEAL_ADVANCED";
  } else if (action === "regress") {
    to = prevOpenStage(deal.status);
    if (!to) return { error: `"${deal.status}" has no previous pipeline stage.`, status: 409 };
    activityAction = "DEAL_REGRESSED";
  } else if (action === "win") {
    if (!OPEN_PIPELINE.includes(deal.status)) return { error: `A deal in "${deal.status}" can't be won — it's already closed.`, status: 409 };
    to = "WON";
    activityAction = "DEAL_WON";
  } else if (action === "lose") {
    if (!OPEN_PIPELINE.includes(deal.status)) return { error: `A deal in "${deal.status}" can't be lost — it's already closed.`, status: 409 };
    to = "LOST";
    activityAction = "DEAL_LOST";
  } else {
    if (!["WON", "LOST"].includes(deal.status)) return { error: `Only a WON or LOST deal can be reopened (this one is "${deal.status}").`, status: 409 };
    to = "NEW";
    activityAction = "DEAL_REOPENED";
  }

  const now = new Date().toISOString();
  const updateFields = { status: to, updatedAt: now };
  if (to === "WON" || to === "LOST") updateFields.closedAt = now;
  if (to === "NEW") updateFields.closedAt = null;

  const updated = await crmDeals.findOneAndUpdate(
    { _id: dealObjectId, orgId: orgObjectId, status: deal.status },
    { $set: updateFields },
    { returnDocument: "after" }
  );
  if (!updated) {
    return { error: `This deal's stage changed since it was loaded (was "${deal.status}") — reload and try again.`, status: 409 };
  }

  await logOrgActivity({
    orgId: orgObjectId,
    recordType: "DEAL",
    recordId: dealObjectId,
    actorEmail,
    action: activityAction,
    previousState: deal.status,
    newState: to,
    metadata: note ? { note } : {},
  });

  return { deal: updated };
}
