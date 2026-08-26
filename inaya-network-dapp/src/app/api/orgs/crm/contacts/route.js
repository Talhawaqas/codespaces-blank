// app/api/orgs/crm/contacts/route.js
//
// GET  /api/orgs/crm/contacts?orgId=...&departmentId=...&type=LEAD|CUSTOMER&search=...
//   -> department-filtered or, with no departmentId, the caller's full
//      accessible scope (same "no filter = accessible scope" convention
//      as GET /api/orgs/tasks).
// POST /api/orgs/crm/contacts  { orgId, departmentId, type?, name, email?, phone?, company?, notes? }
//   -> create (any member with access to the department — a contact
//      isn't a confidential record the way a specific document can be).
//
// A contact IS the unified Lead/Customer record — `type` flips from LEAD
// to CUSTOMER on conversion rather than the record being recreated, so
// its history/notes/deals stay attached across that transition.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";

const CONTACT_TYPES = ["LEAD", "CUSTOMER"];

function serializeContact(c) {
  return {
    id: c._id.toString(),
    orgId: c.orgId.toString(),
    departmentId: c.departmentId.toString(),
    type: c.type,
    name: c.name,
    email: c.email || null,
    phone: c.phone || null,
    company: c.company || null,
    notes: c.notes || null,
    createdByEmail: c.createdByEmail,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const type = searchParams.get("type");
    const search = searchParams.get("search");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let list;
    if (departmentId) {
      if (!canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
      }
      const { crmContacts } = await getOrgCollections();
      list = await crmContacts.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visibleContacts;
    }

    if (type && CONTACT_TYPES.includes(type)) list = list.filter((c) => c.type === type);
    if (search) {
      const needle = search.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(needle) || (c.company || "").toLowerCase().includes(needle) || (c.email || "").toLowerCase().includes(needle));
    }

    return NextResponse.json({ contacts: list.map(serializeContact) });
  } catch (err) {
    console.error("orgs/crm/contacts GET failed:", err);
    return NextResponse.json({ error: "Could not fetch contacts." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, type: rawType, name: rawName, email, phone, company, notes } = await req.json();
    const name = String(rawName || "").trim();
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });
    if (!name) return NextResponse.json({ error: "Contact name is required." }, { status: 400 });
    const type = CONTACT_TYPES.includes(rawType) ? rawType : "LEAD";

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { departments, crmContacts } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    const now = new Date().toISOString();
    const result = await crmContacts.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, type, name,
      email: email ? String(email).trim().toLowerCase() : null,
      phone: phone ? String(phone).trim() : null,
      company: company ? String(company).trim() : null,
      notes: notes ? String(notes).trim() : null,
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now, deletedAt: null,
    });

    return NextResponse.json(serializeContact({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, type, name,
      email, phone, company, notes, createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/crm/contacts POST failed:", err);
    return NextResponse.json({ error: "Could not create the contact." }, { status: 500 });
  }
}
