// app/api/orgs/documents/[documentId]/retrieve/route.js
//
// GET /api/orgs/documents/:documentId/retrieve?orgId=...
//
// The ONLY route in this codebase that returns a document's cidAlpha/
// cidBeta — the list endpoint deliberately never does (metadata only).
// This is the "Secure Document Retrieval" chain from the SOW: authenticate
// -> identify org -> check membership -> resolve document permission ->
// only then hand back the encrypted-content pointers. VIEW-level access
// is enough (viewing IS retrieving, for an encrypted document — the actual
// content stays unreadable without the client-side passkey, which this
// route never sees).
//
// Knowing a documentId or a CID never substitutes for this check — a
// request for a document in a different org 404s the same way
// document-workflow.js's org isolation does (requireDocumentAccess scopes
// the lookup by orgId), and a fabricated/foreign CID was never stored
// against this document in the first place, so there's nothing to "guess"
// into working.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireDocumentAccess } from "../../../../../../lib/document-permissions.js";

export async function GET(req, { params }) {
  try {
    const { documentId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const access = await requireDocumentAccess({ orgId, documentId, membership: auth.membership, email: auth.session.email, minLevel: "VIEW" });
    if (access.error) return NextResponse.json({ error: access.error }, { status: access.status });

    return NextResponse.json({
      filename: access.doc.filename,
      sizeBytes: access.doc.sizeBytes,
      cidAlpha: access.doc.cidAlpha,
      cidBeta: access.doc.cidBeta,
      yourAccessLevel: access.accessLevel,
    });
  } catch (err) {
    console.error("orgs/documents/[documentId]/retrieve failed:", err);
    return NextResponse.json({ error: "Could not retrieve the document." }, { status: 500 });
  }
}
