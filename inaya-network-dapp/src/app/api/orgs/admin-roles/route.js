// app/api/orgs/admin-roles/route.js -- role-based administration (Competitive Expansion SOW T). Owner/admin only.
//   GET ?orgId           members with their scoped administrator roles, plus the catalog
//   PUT { orgId, email, adminRoles: [...] }   replace one member's scoped roles (an empty list removes them)
// The roles are optional extra scopes on top of owner/admin/member (see ADMIN_ROLES in orgGates.js); owner and admin already hold every scope.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../lib/orgs.js";
import { ADMIN_ROLES, canManageOrg } from "../../../../lib/orgGates.js";
import { logOrgActivity } from "../../../../lib/org-activity-log.js";
import { ObjectId } from "mongodb";
export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function GET(req) {
  const orgId = new URL(req.url).searchParams.get("orgId"); if (!orgId) return json({ error: "orgId is required." }, 400);
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
  if (!canManageOrg(auth.membership)) return json({ error: "Only an owner or admin can manage administrator roles." }, 403);
  const { orgMembers } = await getOrgCollections(); const rows = await orgMembers.find({ orgId: toObjectId(orgId), status: "active" }).project({ email: 1, role: 1, adminRoles: 1 }).sort({ email: 1 }).limit(500).toArray();
  return json({ catalog: ADMIN_ROLES, members: rows.map((m) => ({ email: m.email, role: m.role, adminRoles: m.adminRoles || [] })) });
}
export async function PUT(req) {
  let body = {}; try { body = await req.json(); } catch { body = {}; } const { orgId, email } = body; if (!orgId || !email) return json({ error: "orgId and email are required." }, 400);
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
  if (!canManageOrg(auth.membership)) return json({ error: "Only an owner or admin can manage administrator roles." }, 403);
  const list = Array.isArray(body.adminRoles) ? [...new Set(body.adminRoles)] : null; if (!list || list.some((r) => !ADMIN_ROLES[r])) return json({ error: `adminRoles must be drawn from: ${Object.keys(ADMIN_ROLES).join(", ")}.` }, 400);
  const { orgMembers } = await getOrgCollections(); const em = String(email).trim().toLowerCase();
  const r = await orgMembers.updateOne({ orgId: toObjectId(orgId), email: em, status: "active" }, { $set: { adminRoles: list } }); if (!r.matchedCount) return json({ error: "That person is not an active member." }, 404);
  await logOrgActivity({ orgId, recordType: "ORG_MEMBER", recordId: new ObjectId(), actorEmail: auth.session.email, action: "ADMIN_ROLES_SET", previousState: null, newState: null, metadata: { member: em, adminRoles: list } }).catch(() => {});
  return json({ ok: true, email: em, adminRoles: list });
}
