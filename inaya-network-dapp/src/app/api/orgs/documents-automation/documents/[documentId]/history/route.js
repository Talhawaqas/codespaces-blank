// GET /api/orgs/documents-automation/documents/[documentId]/history?orgId=
//   -> everything that happened to this document: its evidence-node chain,
//      all versions of the same series, deliveries and recipient access,
//      and the Evidence Graph timeline (reused from businessEvents.js).
import { NextResponse } from "next/server";
import { authed, fail, respond } from "../../../_lib.js";
import { getDocument } from "../../../../../../../lib/documentAutomation/pipeline.js";
import { listDeliveries } from "../../../../../../../lib/documentAutomation/delivery.js";
import { verifyEvidenceChain } from "../../../../../../../lib/documentAutomation/evidence.js";
import { getBusinessEventTimeline } from "../../../../../../../lib/businessEvents.js";
import { getOrgCollections, toObjectId } from "../../../../../../../lib/orgs.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const { documentId } = await params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    const a = await authed(req, orgId);
    if (a.response) return a.response;
    const got = await getDocument({ orgId, documentId, membership: a.membership, email: a.email });
    if (got.error) return respond(got);
    const raw = got.raw;
    const { generatedDocuments } = await getOrgCollections();
    const versions = await generatedDocuments.find({ orgId: toObjectId(orgId), seriesKey: raw.seriesKey, deletedAt: null }, { projection: { documentVersion: 1, status: 1, documentHash: 1, finalizedAt: 1, createdAt: 1, supersededByDocumentId: 1 } }).sort({ documentVersion: 1 }).toArray();
    const deliveries = await listDeliveries({ orgId, documentId, membership: a.membership, email: a.email });
    const timeline = raw.businessEventId ? await getBusinessEventTimeline({ orgId, eventId: String(raw.businessEventId), membership: a.membership }).catch(() => null) : null;
    return NextResponse.json({
      document: got.document,
      evidence: { chain: verifyEvidenceChain(raw.evidenceNodes || []), nodes: (raw.evidenceNodes || []).map((n) => ({ seq: n.seq, nodeType: n.nodeType, at: n.at, actorType: n.actor?.type, actor: n.actor?.email, dataHash: n.dataHash, nodeHash: n.nodeHash, auditRef: n.auditRef || null, data: n.data })) },
      versions: versions.map((v) => ({ id: String(v._id), version: v.documentVersion, status: v.status, documentHash: v.documentHash, finalizedAt: v.finalizedAt || null, createdAt: v.createdAt, supersededByDocumentId: v.supersededByDocumentId ? String(v.supersededByDocumentId) : null })),
      deliveries: deliveries.error ? [] : deliveries.deliveries, accessEvents: deliveries.error ? [] : deliveries.accessEvents,
      timeline: timeline?.timeline?.map((t) => ({ recordType: t.recordType, action: t.action, actorEmail: t.actorEmail, timestamp: t.timestamp, previousState: t.previousState, newState: t.newState })) || [],
    });
  } catch (err) { return fail(err, "history GET"); }
}
