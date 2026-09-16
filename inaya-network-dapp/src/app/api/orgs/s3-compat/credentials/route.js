// app/api/orgs/s3-compat/credentials/route.js
//
// Org-side S3/Azure-compatibility credential management -- lives inside
// Business Workspace's own session-authenticated API namespace, exactly
// like api/orgs/api-keys/route.js, so an org owner/admin never has to
// leave Business Workspace or connect a wallet to get an S3 credential.
//
// POST /api/orgs/s3-compat/credentials — body: { orgId, label? }. Returns
//      the raw secretAccessKey exactly once.
// GET  /api/orgs/s3-compat/credentials?orgId= — list this org's credentials
//      (never the raw secret).
//
// Owner/admin only, same gate as api-keys.js -- an S3 credential can read
// and write every document this org has through the compatibility layer.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg } from "../../../../../lib/orgs.js";
import { issueS3Credential, listS3Credentials, ensureS3CompatIndexes } from "../../../../../lib/s3-compat/credentials.js";
import { getOrgCollections } from "../../../../../lib/orgs.js";

export async function POST(req) {
  try {
    const { orgId, label, scope } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const { db } = await getOrgCollections();
    await ensureS3CompatIndexes(db);
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can create an S3-compatible credential." }, { status: 403 });

    // Granular Storage Access Grants (SOW §2) -- `scope` is optional; when
    // provided it's validated/normalized by credentials.js's own
    // normalizeScope and enforced server-side on every request, never
    // trusted as-is from this or any other caller.
    let result;
    try {
      result = await issueS3Credential({ owner: { type: "org", orgId }, label, actorEmail: auth.session.email, scope });
    } catch (err) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({
      ...result,
      endpoint: "/api/s3",
      region: "inaya",
      note: "Use this endpoint with any S3-compatible tool: --endpoint-url pointed at this host's /api/s3 path.",
    });
  } catch (err) {
    console.error("orgs/s3-compat/credentials POST failed:", err);
    return NextResponse.json({ error: "Could not create the S3-compatible credential." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can view S3-compatible credentials." }, { status: 403 });

    const result = await listS3Credentials({ type: "org", orgId });
    return NextResponse.json({ credentials: result });
  } catch (err) {
    console.error("orgs/s3-compat/credentials GET failed:", err);
    return NextResponse.json({ error: "Could not list S3-compatible credentials." }, { status: 500 });
  }
}
