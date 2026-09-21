// app/api/orgs/data-room-templates/route.js
//
// GET  ?orgId= -> { templates: [...org's own], builtin: {...gallery} }
// POST { orgId, name, description, roomType, sections, ndaRequired, ndaText, defaultAccessExpiryHours } -> create a custom template
// POST { orgId, cloneBuiltin: "fundraising" } -> clone one of the built-in examples into a real, editable org template

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createDataRoomTemplate, cloneBuiltinTemplate, listDataRoomTemplates, BUILTIN_TEMPLATES } from "../../../../lib/dataRoomTemplates.js";

function serialize(t) {
  return {
    id: t._id.toString(), name: t.name, description: t.description, roomType: t.roomType, sections: t.sections || [],
    ndaRequired: !!t.ndaRequired, defaultAccessExpiryHours: t.defaultAccessExpiryHours, clonedFromBuiltin: t.clonedFromBuiltin || null,
    createdByEmail: t.createdByEmail, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const templates = await listDataRoomTemplates(orgId);
    return NextResponse.json({ templates: templates.map(serialize), builtin: BUILTIN_TEMPLATES });
  } catch (err) {
    console.error("orgs/data-room-templates GET failed:", err);
    return NextResponse.json({ error: "Could not fetch data room templates." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, cloneBuiltin } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = cloneBuiltin
      ? await cloneBuiltinTemplate({ orgId, builtinKey: cloneBuiltin, actorEmail: auth.session.email, membership: auth.membership })
      : await createDataRoomTemplate({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ template: serialize(result.template) });
  } catch (err) {
    console.error("orgs/data-room-templates POST failed:", err);
    return NextResponse.json({ error: "Could not create the data room template." }, { status: 500 });
  }
}
