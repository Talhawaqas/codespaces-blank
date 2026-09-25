// app/api/documents-automation/deliver/[token]/route.js
//
// GET /api/documents-automation/deliver/:token            -> the PDF (view)
// GET /api/documents-automation/deliver/:token?download=1  -> the PDF (download; logged as a download)
// GET /api/documents-automation/deliver/:token?meta=1      -> non-consuming metadata for the recipient page
//
// The unauthenticated recipient-facing route (SOW §16/§19): no session, no
// org membership -- the 256-bit token is the security boundary. Unlike the
// org_documents share route (client-side encrypted, hands the client
// cidAlpha/cidBeta), generated documents are server-managed encrypted, so
// this route decrypts server-side, re-verifies the stored bytes against the
// recorded hash, and serves the PDF. Every access is logged and rate limited
// per IP (link enumeration protection). The response reveals no internal ids.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { getClientIp } from "../../../../../lib/rateLimit.js";
import { resolveDeliveryAccess, peekShare } from "../../../../../lib/documentAutomation/delivery.js";
import { limited, pdfResponse } from "../../../orgs/documents-automation/_lib.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req, { params }) {
  try {
    const { token } = await params;
    const rl = await limited(req, { action: "deliver", max: 90 });
    if (rl) return rl;
    await ensureOrgIndexes();
    const sp = new URL(req.url).searchParams;

    if (sp.get("meta") === "1") {
      const peeked = await peekShare(token);
      if (peeked.error) return NextResponse.json({ error: peeked.error }, { status: peeked.status });
      return NextResponse.json({ document: peeked.meta }, { headers: { "Cache-Control": "no-store" } });
    }

    const result = await resolveDeliveryAccess(token, { download: sp.get("download") === "1", ip: getClientIp(req) });
    if (result.error) return NextResponse.json({ error: result.error, ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}) }, { status: result.status });
    return pdfResponse(result.buffer, result.filename, { hash: result.documentHash, inline: sp.get("download") !== "1" });
  } catch (err) {
    console.error("documents-automation/deliver/[token] failed:", err);
    return NextResponse.json({ error: "Could not resolve this link." }, { status: 500 });
  }
}
