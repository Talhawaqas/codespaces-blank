// app/api/orgs/training/route.js
// GET   ?orgId=&mine=1 -> the caller's own training records; else (manager) all training
// POST  { orgId, policyKey, title, memberEmails, dueDate } -> assign training
// PATCH { orgId, trainingRecordId } -> acknowledge (caller's own record only)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { assignTraining, acknowledgeTraining, listTrainingFor, listAllTraining } from "../../../../lib/training.js";

function serialize(t) {
  return { id: t._id.toString(), policyKey: t.policyKey, title: t.title, memberEmail: t.memberEmail, dueDate: t.dueDate, acknowledgedAt: t.acknowledgedAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const mine = searchParams.get("mine");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, mine ? {} : { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const records = mine ? await listTrainingFor(orgId, auth.session.email) : await listAllTraining(orgId);
    return NextResponse.json({ training: records.map(serialize) });
  } catch (err) {
    console.error("orgs/training GET failed:", err);
    return NextResponse.json({ error: "Could not fetch training records." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.title || !body.memberEmails?.length) return NextResponse.json({ error: "orgId, title, and at least one memberEmail are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await assignTraining({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ assigned: result.assigned.map(serialize) });
  } catch (err) {
    console.error("orgs/training POST failed:", err);
    return NextResponse.json({ error: "Could not assign training." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, trainingRecordId } = await req.json();
    if (!orgId || !trainingRecordId) return NextResponse.json({ error: "orgId and trainingRecordId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await acknowledgeTraining({ orgId, trainingRecordId, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ training: serialize(result.training) });
  } catch (err) {
    console.error("orgs/training PATCH failed:", err);
    return NextResponse.json({ error: "Could not acknowledge training." }, { status: 500 });
  }
}
