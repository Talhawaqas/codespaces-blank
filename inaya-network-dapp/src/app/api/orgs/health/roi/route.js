// app/api/orgs/health/roi/route.js
// GET   ?orgId=&patientId= -> list ROI requests for a patient
// POST  { orgId, patientId, purpose, recipient, requestedRecordIds } -> submit
// PATCH { orgId, roiRequestId, action:"authorize"|"approve"|"reject" } -> advance

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { requestReleaseOfInformation, authorizeReleaseOfInformation, reviewReleaseOfInformation, listRoiRequestsForPatient } from "../../../../../lib/health-roi-workflow.js";

function serialize(r) {
  return { id: r._id.toString(), status: r.status, purpose: r.purpose, recipient: r.recipient, createdAt: r.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const patientId = searchParams.get("patientId");
    if (!orgId || !patientId) return NextResponse.json({ error: "orgId and patientId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    if (!scope.visiblePatients.some((p) => p._id.toString() === patientId)) {
      return NextResponse.json({ error: "Patient not found." }, { status: 404 });
    }
    const requests = await listRoiRequestsForPatient(orgId, patientId);
    return NextResponse.json({ requests: requests.map(serialize) });
  } catch (err) {
    console.error("orgs/health/roi GET failed:", err);
    return NextResponse.json({ error: "Could not fetch release requests." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.patientId || !body.purpose) return NextResponse.json({ error: "orgId, patientId, and purpose are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(body.orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await requestReleaseOfInformation({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.roiRequest) });
  } catch (err) {
    console.error("orgs/health/roi POST failed:", err);
    return NextResponse.json({ error: "Could not submit release request." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, roiRequestId, action } = await req.json();
    if (!orgId || !roiRequestId || !action) return NextResponse.json({ error: "orgId, roiRequestId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "healthcare");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    let result;
    if (action === "authorize") {
      result = await authorizeReleaseOfInformation({ orgId, roiRequestId, actorEmail: auth.session.email, membership: auth.membership });
    } else if (action === "approve" || action === "reject") {
      result = await reviewReleaseOfInformation({ orgId, roiRequestId, approve: action === "approve", actorEmail: auth.session.email, membership: auth.membership });
    } else {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.roiRequest) });
  } catch (err) {
    console.error("orgs/health/roi PATCH failed:", err);
    return NextResponse.json({ error: "Could not update release request." }, { status: 500 });
  }
}
