// src/lib/support/packageTier.js
//
// Priority support by package (pricing cards in orgPlans.js; founder decision 26 Nov 2026). Only on Inaya's OWN support desk
// (INAYA_SUPPORT_ORG_ID): a requester's support tier comes from the best Business OS package among the companies they are an
// active member of. A tier set by hand on the customer's support profile always wins.
//   Enterprise              -> ENTERPRISE (priority raised one level; published first reply: 8 hours)
//   Business, Professional  -> PRIORITY   (published first reply: 24 hours)
//   Starter / no billing    -> STANDARD   (published first reply: 48 hours)
//   no package (legacy)     -> none (the desk's default policy)
import { getOrgCollections } from "../orgs.js";
import { PLAN_ORDER } from "../orgPlans.js";

export const TIER_FOR_PLAN = { enterprise: "ENTERPRISE", business: "PRIORITY", professional: "PRIORITY", starter: "STANDARD" };

/** Pure: the tier for a set of organization documents ({ plan, noPlanConfirmedAt }). */
export function tierForOrgs(orgs) {
  let best = -1;
  for (const o of orgs || []) { const id = o?.plan || (o?.noPlanConfirmedAt ? "starter" : null); const r = PLAN_ORDER.indexOf(id); if (r > best) best = r; }
  return best < 0 ? null : TIER_FOR_PLAN[PLAN_ORDER[best]];
}

export async function packageTier(deskOrgId, email, env = process.env) {
  if (!env.INAYA_SUPPORT_ORG_ID || String(deskOrgId) !== env.INAYA_SUPPORT_ORG_ID) return null;
  try {
    const { orgMembers, orgs } = await getOrgCollections();
    const ids = (await orgMembers.find({ email, status: "active" }, { projection: { orgId: 1 } }).limit(50).toArray()).map((m) => m.orgId);
    if (!ids.length) return null;
    return tierForOrgs(await orgs.find({ _id: { $in: ids } }, { projection: { plan: 1, noPlanConfirmedAt: 1 } }).toArray());
  } catch { return null; }
}
