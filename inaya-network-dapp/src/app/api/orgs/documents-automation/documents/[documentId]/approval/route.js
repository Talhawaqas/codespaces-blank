// GET  /api/orgs/documents-automation/documents/[documentId]/approval?orgId=
//        -> the approval package for THIS exact version: calculations, source
//           snapshot, validation checks, changes vs the previous version, and
//           a live source-drift check.
// POST /api/orgs/documents-automation/documents/[documentId]/approval
//        { orgId, action: "request" | "approve" | "reject", note? }
import { NextResponse } from "next/server";
import { authed, fail, respond, readJson, limited } from "../../../_lib.js";
import { requestApproval, decideApproval, getApprovalPackage } from "../../../../../../../lib/documentAutomation/lifecycle.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req, { params }) {
  try {
    const { documentId } = await params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    return respond(await getApprovalPackage({ orgId, documentId, membership: a.membership, email: a.email }));
  } catch (err) { return fail(err, "approval GET"); }
}

export async function POST(req, { params }) {
  try {
    const { documentId } = await params;
    const j = await readJson(req);
    if (j.error) return respond(j);
    const { orgId, action, note } = j.body;
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const rl = await limited(req, { action: "approval", max: 60, key: a.email });
    if (rl) return rl;
    const common = { orgId, documentId, membership: a.membership, email: a.email, actorType: "human" };
    if (action === "request") return respond(await requestApproval({ ...common, note }));
    if (action === "approve" || action === "reject") return respond(await decideApproval({ ...common, decision: action, note }));
    return NextResponse.json({ error: 'action must be "request", "approve" or "reject".' }, { status: 400 });
  } catch (err) { return fail(err, "approval POST"); }
}
