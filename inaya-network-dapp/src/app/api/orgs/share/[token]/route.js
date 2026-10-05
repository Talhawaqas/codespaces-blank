// app/api/orgs/share/[token]/route.js
//
// GET /api/orgs/share/:token
//
// The ONLY unauthenticated route in the entire org/document system — this
// is what an external recipient's browser calls when they open a share
// link. No session cookie, no org membership, nothing beyond the token
// itself (which is why consumeDocumentShare()'s atomic expiry/revocation/
// max-uses check IS the entire security boundary here).
//
// The response deliberately contains ONLY what's needed to fetch and
// decrypt the file client-side: filename, sizeBytes, cidAlpha, cidBeta —
// see resolveShareAccess() (document-permissions.js), which also owns the
// activity logging for this flow. No documentId, orgId, or share _id ever
// goes back to the caller. Even those content pointers only mean anything
// to someone who separately has the client-side encryption passkey
// (communicated out of band, same as every other encrypted document in
// this system) — this route never sees or asks for it.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { resolveShareAccess } from "../../../../../lib/document-permissions.js";
import { peekShare } from "../../../../../lib/sharing/shares.js";

export async function GET(req, { params }) {
  try {
    const { token } = await params;
    await ensureOrgIndexes();

    // Sharing 2.0 links answer with what the visitor must provide (never a storage pointer, never consuming a use) and are opened
    // through POST .../access; everything else is the original flow below, unchanged.
    const peek = await peekShare(token);
    if (peek) return NextResponse.json(peek);

    const result = await resolveShareAccess(token);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/share/[token] failed:", err);
    return NextResponse.json({ error: "Could not resolve this link." }, { status: 500 });
  }
}
