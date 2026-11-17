// app/api/orgs/uploads/chunked/route.js
//
// POST /api/orgs/uploads/chunked  — large Business Workspace documents (src/lib/chunkedFile.js).
//   { action: "start", orgId, sizeBytes }              -> { uploadId, token, pieceSize, count }   (plan limits checked here)
//   { action: "sign", orgId, token, from, count }      -> { pieces: [{ index, alpha: {key,url}, beta: {key,url} }] }
//   { action: "manifests", orgId, token }              -> { alpha: {key,url}, beta: {key,url} }
//   { action: "abort", orgId, token }                  -> { deleted }   (removes whatever this upload stored)
// Only signed links pass through here; the encrypted pieces go straight from the browser to storage.
// Every call re-checks membership, and the token must belong to this org and this member.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, getOrgCollections, requireMembership, toObjectId } from "../../../../../lib/orgs.js";
import { checkUploadAgainstPlan } from "../../../../../lib/orgPlans.js";
import { ChunkedError, startUpload, readUploadToken, signPieces, signManifests, deletePrefix, prefixFor } from "../../../../../lib/chunkedStorage.js";
import { CHUNKED_THRESHOLD_BYTES } from "../../../../../lib/chunkedFile.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { action, orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const email = auth.session.email;

    if (action === "start") {
      const size = Number(body.sizeBytes);
      if (!Number.isFinite(size) || size <= CHUNKED_THRESHOLD_BYTES) return NextResponse.json({ error: "Only large files use this upload." }, { status: 400 });
      const { orgs } = await getOrgCollections();
      const org = await orgs.findOne({ _id: toObjectId(orgId) });
      if (!org) return NextResponse.json({ error: "Company not found." }, { status: 404 });
      const planBlock = await checkUploadAgainstPlan({ org, orgId, sizeBytes: size });
      if (planBlock) return NextResponse.json({ error: planBlock.error }, { status: planBlock.status });
      return NextResponse.json(startUpload({ orgId, email, sizeBytes: size }));
    }

    const claims = readUploadToken(body.token, { orgId, email, allowExpired: action === "abort" });
    if (action === "sign") return NextResponse.json({ pieces: await signPieces(claims, body.from, body.count) });
    if (action === "manifests") return NextResponse.json(await signManifests(claims));
    if (action === "abort") {
      // Never delete an upload that became a document.
      const { orgDocuments } = await getOrgCollections();
      const prefix = prefixFor(claims.orgId, claims.uploadId);
      if (await orgDocuments.findOne({ "storage.prefix": prefix }, { projection: { _id: 1 } })) return NextResponse.json({ deleted: 0 });
      return NextResponse.json(await deletePrefix(prefix));
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    if (err instanceof ChunkedError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("orgs/uploads/chunked failed:", err?.name, String(err?.message || "").slice(0, 200));
    return NextResponse.json({ error: "The upload could not continue. Try again." }, { status: 500 });
  }
}
