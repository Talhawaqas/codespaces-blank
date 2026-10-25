// app/api/admin/leads/route.js
//
// Admin only (the admin dashboard session). Inaya's own outreach prospects:
// GET ?batch=PK&status=NEW lists them with per-batch status counts;
// POST { action: "create", lead } adds one; POST { action: "update", id, ...fields }
// changes status, notes or contact details. See src/lib/salesLeads.js.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth";
import { listLeads, createLead, updateLead } from "../../../../lib/salesLeads.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const url = new URL(req.url);
  try {
    return NextResponse.json(await listLeads({ batch: url.searchParams.get("batch"), status: url.searchParams.get("status") }));
  } catch (err) {
    console.error("admin/leads GET failed:", err);
    return NextResponse.json({ error: "Could not load leads." }, { status: 500 });
  }
}

export async function POST(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  try {
    const result = body.action === "create"
      ? await createLead(body.lead || {})
      : body.action === "update"
      ? await updateLead(body.id, body)
      : { error: "action must be create or update.", status: 400 };
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("admin/leads POST failed:", err);
    return NextResponse.json({ error: "Could not save the lead." }, { status: 500 });
  }
}
