// app/api/orgs/data-room-templates/[templateId]/route.js
//
// PATCH { orgId, name?, description?, sections?, ndaRequired?, ndaText?, defaultAccessExpiryHours? }
// Editing a template never touches any room already created from it.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { updateDataRoomTemplate } from "../../../../../lib/dataRoomTemplates.js";

export async function PATCH(req, { params }) {
  try {
    const { templateId } = await params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updateDataRoomTemplate({ ...body, orgId, templateId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ template: result.template });
  } catch (err) {
    console.error("orgs/data-room-templates/[templateId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update this template." }, { status: 500 });
  }
}
