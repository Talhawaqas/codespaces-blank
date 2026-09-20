// app/api/orgs/business-events/[eventId]/passport/route.js
//
// GET /api/orgs/business-events/:eventId/passport?orgId=&format=json|pdf
// Generates a portable Business Event Passport (SOW §17) on demand — read-
// only aggregation, no stored passport document (mirrors evidence-export's
// own on-demand generation, same self-audit discipline).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { buildBusinessEventPassport, renderBusinessEventPassportPdf } from "../../../../../../lib/businessEventPassport.js";

export async function GET(req, { params }) {
  try {
    const { eventId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await buildBusinessEventPassport({ orgId, eventId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    const format = searchParams.get("format") === "pdf" ? "pdf" : "json";
    if (format === "pdf") {
      const pdfBuffer = await renderBusinessEventPassportPdf(result.passport);
      return new Response(pdfBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="inaya-business-event-${eventId}-passport.pdf"`,
          "X-Passport-Manifest-Hash": result.passport.manifestHash,
        },
      });
    }

    return NextResponse.json({ passport: result.passport });
  } catch (err) {
    console.error("orgs/business-events/[eventId]/passport GET failed:", err);
    return NextResponse.json({ error: "Could not generate the business event passport." }, { status: 500 });
  }
}
