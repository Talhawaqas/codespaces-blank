// app/api/orgs/crm/deals/route.js
//
// GET  /api/orgs/crm/deals?orgId=...&departmentId=...&contactId=...&stage=...
//   -> department-filtered, contact-filtered, or the caller's full
//      accessible scope with no filter.
// POST /api/orgs/crm/deals  { orgId, departmentId, contactId, title, value?, projectId? }
//   -> create, starts at stage NEW. `projectId` is optional and is the
//      field that completes Customer -> Deal -> Project -> Task ->
//      Document per the SOW — linking a deal to an existing project
//      requires department access to THAT project's department too, so
//      a deal can't be used to point at a project the caller can't see.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { DEAL_STAGES } from "../../../../../lib/deal-workflow.js";

function serializeDeal(d) {
  return {
    id: d._id.toString(), orgId: d.orgId.toString(), departmentId: d.departmentId.toString(),
    contactId: d.contactId.toString(), projectId: d.projectId ? d.projectId.toString() : null,
    title: d.title, value: d.value ?? null, status: d.status,
    createdByEmail: d.createdByEmail, createdAt: d.createdAt, updatedAt: d.updatedAt, closedAt: d.closedAt || null,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const contactId = searchParams.get("contactId");
    const stage = searchParams.get("stage");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let list;
    if (departmentId || contactId) {
      const { crmDeals } = await getOrgCollections();
      const query = { orgId: toObjectId(orgId), deletedAt: null };
      if (departmentId) {
        if (!canAccessDepartment(auth.membership, departmentId)) {
          return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
        }
        query.departmentId = toObjectId(departmentId);
      }
      if (contactId) query.contactId = toObjectId(contactId);
      list = await crmDeals.find(query).sort({ createdAt: -1 }).toArray();
      if (contactId && !departmentId) {
        const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
        const visibleIds = new Set(scope.visibleDeals.map((d) => d._id.toString()));
        list = list.filter((d) => visibleIds.has(d._id.toString()));
      }
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visibleDeals;
    }

    if (stage && DEAL_STAGES.includes(stage)) list = list.filter((d) => d.status === stage);

    return NextResponse.json({ deals: list.map(serializeDeal) });
  } catch (err) {
    console.error("orgs/crm/deals GET failed:", err);
    return NextResponse.json({ error: "Could not fetch deals." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, contactId, title: rawTitle, value, projectId } = await req.json();
    const title = String(rawTitle || "").trim();
    if (!orgId || !departmentId || !contactId) return NextResponse.json({ error: "orgId, departmentId, and contactId are required." }, { status: 400 });
    if (!title) return NextResponse.json({ error: "Deal title is required." }, { status: 400 });
    if (value !== undefined && value !== null && !Number.isFinite(value)) return NextResponse.json({ error: "value must be a number." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { crmContacts, projects, crmDeals } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const contactObjectId = toObjectId(contactId);

    const contact = await crmContacts.findOne({ _id: contactObjectId, orgId: orgObjectId, deletedAt: null });
    if (!contact) return NextResponse.json({ error: "Contact not found." }, { status: 404 });

    let projectObjectId = null;
    if (projectId) {
      projectObjectId = toObjectId(projectId);
      const project = await projects.findOne({ _id: projectObjectId, orgId: orgObjectId });
      if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
      if (!canAccessDepartment(auth.membership, project.departmentId)) {
        return NextResponse.json({ error: "You don't have access to that project's department." }, { status: 403 });
      }
    }

    const now = new Date().toISOString();
    const result = await crmDeals.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, contactId: contactObjectId, projectId: projectObjectId,
      title, value: value ?? null, status: "NEW",
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now, closedAt: null, deletedAt: null,
    });

    return NextResponse.json(serializeDeal({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, contactId: contactObjectId,
      projectId: projectObjectId, title, value: value ?? null, status: "NEW",
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/crm/deals POST failed:", err);
    return NextResponse.json({ error: "Could not create the deal." }, { status: 500 });
  }
}
