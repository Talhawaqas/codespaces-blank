// app/api/documents-automation/deliver/[token]/route.js
//
// GET /api/documents-automation/deliver/:token
//
// The unauthenticated recipient-facing route (SOW §16/§19) -- no session
// cookie, no org membership, the token itself IS the entire security
// boundary (same model as the existing api/orgs/share/[token] route's
// own documented pattern). Unlike that route, which hands the CLIENT
// cidAlpha/cidBeta to decrypt (org_documents are client-side encrypted),
// generated documents are server-managed encryption (see generate.js's
// header) -- there's no external recipient passkey to hand out for a
// PDF the server itself produced, so this route decrypts server-side
// and serves the real PDF bytes directly once the token validates.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { resolveDocumentDelivery } from "../../../../../lib/documentAutomation/delivery.js";

export async function GET(req, { params }) {
  try {
    const { token } = await params;
    await ensureOrgIndexes();

    const result = await resolveDocumentDelivery(token);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return new NextResponse(result.buffer, {
      status: 200,
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `inline; filename="${result.filename}"`,
        "X-Document-Hash": result.documentHash,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("documents-automation/deliver/[token] failed:", err);
    return NextResponse.json({ error: "Could not resolve this link." }, { status: 500 });
  }
}
