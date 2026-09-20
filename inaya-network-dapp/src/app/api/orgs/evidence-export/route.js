// app/api/orgs/evidence-export/route.js
//
// GET ?orgId=&format=json|pdf&since=&until= -> a read-only compliance
// evidence package (Enterprise Adoption SOW, Workstream C). requireManage
// (owner/admin) rather than any member: this surfaces the org's whole
// audit trail and security event history, sensitive enough to gate the
// same way other admin-only org actions already are.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, toObjectId } from "../../../../lib/orgs.js";
import { buildEvidencePackage } from "../../../../lib/evidenceExporter.js";
import { renderEvidencePdf } from "../../../../lib/evidencePdf.js";
import { logOrgActivity } from "../../../../lib/org-activity-log.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const format = searchParams.get("format") === "pdf" ? "pdf" : "json";
    const sinceIso = searchParams.get("since") || null;
    const untilIso = searchParams.get("until") || null;

    const pkg = await buildEvidencePackage({ orgId, actorEmail: auth.session.email, sinceIso, untilIso });

    // Audit the export itself (SOW §6.8 "Audit of export generation
    // itself where appropriate") -- via the SAME existing audit chain
    // this package just read from, never a second system.
    await logOrgActivity({
      orgId,
      recordType: "compliance_evidence_export",
      recordId: toObjectId(orgId),
      actorEmail: auth.session.email,
      action: "EVIDENCE_EXPORT_GENERATED",
      previousState: null,
      newState: null,
      metadata: { format, exportHash: pkg.exportHash, entryCount: pkg.auditEvidence.entryCount },
    });

    if (format === "pdf") {
      const pdfBuffer = await renderEvidencePdf(pkg);
      return new Response(pdfBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="inaya-evidence-${orgId}.pdf"`,
          "X-Evidence-Export-Hash": pkg.exportHash,
        },
      });
    }

    return NextResponse.json(pkg);
  } catch (err) {
    console.error("orgs/evidence-export GET failed:", err);
    return NextResponse.json({ error: "Could not generate the evidence export." }, { status: 500 });
  }
}
