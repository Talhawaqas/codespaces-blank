// src/lib/workflows/effects.js
//
// SOW §21, §30: side effects (a notification, an email, a Slack post, an
// approval request) must never be duplicated when a worker crashes after doing
// the thing but before recording that it did. Every side effect first CLAIMS a
// deterministic key in `workflowEffects` (unique per org + key). A claim that
// already exists means "someone already did, or is doing, this": the caller
// returns the recorded result instead of repeating it. External sends
// (email/Slack/Gmail) are therefore at-most-once; if a crash left a claim with
// no result, the retry reports the effect as UNCERTAIN rather than risk a
// duplicate message.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "../orgs.js";

export const effectKey = (...parts) => createHash("sha256").update(parts.map(String).join("|")).digest("hex").slice(0, 40);

/** Returns { claimed: true } for the first caller, or { claimed: false, effect } for everyone else. */
export async function claimEffect({ orgId, key, kind, executionId = null, nodeKey = null, meta = {} }) {
  const { workflowEffects } = await getOrgCollections();
  const doc = { orgId: toObjectId(orgId), effectKey: key, kind, executionId: executionId ? toObjectId(executionId) : null, nodeKey, state: "CLAIMED", meta, claimedAt: new Date().toISOString(), completedAt: null, result: null };
  try {
    await workflowEffects.insertOne(doc);
    return { claimed: true };
  } catch (err) {
    if (err?.code === 11000) return { claimed: false, effect: await workflowEffects.findOne({ orgId: doc.orgId, effectKey: key }) };
    throw err;
  }
}

export async function completeEffect({ orgId, key, state = "DONE", result = null }) {
  const { workflowEffects } = await getOrgCollections();
  await workflowEffects.updateOne({ orgId: toObjectId(orgId), effectKey: key }, { $set: { state, result, completedAt: new Date().toISOString() } });
}

/** Lets a retry re-attempt an effect that verifiably did NOT happen (the send threw before any bytes left). */
export async function releaseEffect({ orgId, key }) {
  const { workflowEffects } = await getOrgCollections();
  await workflowEffects.deleteOne({ orgId: toObjectId(orgId), effectKey: key, state: "CLAIMED" });
}

/** Frees a claim whose send was explicitly REJECTED, so a retry can attempt it again. Never frees an uncertain (CLAIMED) or completed one. */
export async function releaseFailedEffect({ orgId, key }) {
  const { workflowEffects } = await getOrgCollections();
  await workflowEffects.deleteOne({ orgId: toObjectId(orgId), effectKey: key, state: "FAILED" });
}
