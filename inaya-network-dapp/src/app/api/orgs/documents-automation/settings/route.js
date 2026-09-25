// GET /api/orgs/documents-automation/settings?orgId=   -> numbering, approval policy, defaults, billing profile (logo bytes never returned)
// PUT /api/orgs/documents-automation/settings   { orgId, numbering?, approval?, defaults?, billingProfile?, retention? }
//   -> Finance Manager / owner / admin only; validated; audited; optimistic-concurrency safe.
import { NextResponse } from "next/server";
import { authed, fail, respond, readJson, limited } from "../_lib.js";
import { getDocumentSettings, updateDocumentSettings, redactSettings } from "../../../../../lib/documentAutomation/settings.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    return NextResponse.json({ settings: redactSettings(await getDocumentSettings(orgId)) });
  } catch (err) { return fail(err, "settings GET"); }
}

export async function PUT(req) {
  try {
    const j = await readJson(req, 400 * 1024);
    if (j.error) return respond(j);
    const { orgId, ...updates } = j.body;
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "settings-write", max: 40, key: a.email });
    if (rl) return rl;
    const result = await updateDocumentSettings({ orgId, updates, membership: a.membership, actorEmail: a.email });
    if (result.error) return respond(result);
    return NextResponse.json({ settings: redactSettings(result.settings) });
  } catch (err) { return fail(err, "settings PUT"); }
}
