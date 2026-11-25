// app/api/orgs/session/route.js
//
// GET /api/orgs/session
//
// Reads the session cookie and returns the caller's identity plus every
// org they're an active member of (with their role in each) — the
// frontend uses this on load to decide "logged out" vs "which org(s) can
// this person switch between."

import { NextResponse } from "next/server";
import { entitledFromOrg } from "../../../../lib/ops/core.js";
import { entitledFromOrg as connectEntitledFromOrg } from "../../../../lib/connect/core.js";
import { getOrgCollections, getSession, getRawSessionToken } from "../../../../lib/orgs.js";

export async function GET(req) {
  const rawToken = getRawSessionToken(req);
  const session = await getSession(rawToken);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const { orgMembers, orgs } = await getOrgCollections();
  const memberships = await orgMembers.find({ email: session.email, status: "active" }).toArray();
  const orgDocs = await orgs.find({ _id: { $in: memberships.map((m) => m.orgId) } }).toArray();
  const orgById = new Map(orgDocs.map((o) => [o._id.toString(), o]));

  return NextResponse.json({
    authenticated: true,
    email: session.email,
    orgs: memberships.map((m) => {
      const org = orgById.get(m.orgId.toString());
      return {
        orgId: m.orgId.toString(),
        orgName: org?.name || "Unknown",
        role: m.role,
        adminRoles: m.adminRoles || [],
        departmentIds: (m.departmentIds || []).map((id) => id.toString()),
        // Frontend gate (business/page.js's PlanSelectionGate) shows a
        // "pick a plan" screen instead of the Dashboard when both are
        // true — orgs from before this field existed don't have it set,
        // so they're unaffected (see requiresPlanSelection's own comment
        // in orgs/create/route.js for why that's the intended behavior).
        plan: org?.plan || null,
        requiresPlanSelection: !!org?.requiresPlanSelection,
        vertical: org?.vertical || "general",
        // Manage Orders menu entry (server re-checks every call): only when the company is entitled.
        manageOrders: entitledFromOrg(org),
        inayaConnect: connectEntitledFromOrg(org),
        opsRole: m.opsRole || null,
      };
    }),
  });
}
