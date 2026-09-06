// app/api/orgs/dr-runbooks/route.js
// GET   ?orgId= -> list DR runbooks, each annotated with attention status
// POST  { orgId, name, restorationProcedure, ... } -> create a runbook
// PATCH { orgId, runbookId, updates } -> update RTO/RPO/backup dependency/procedure

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createRunbook, updateRunbook, listRunbooks, listRunbooksNeedingAttention } from "../../../../lib/disaster-recovery.js";

function serialize(r) {
  return {
    id: r._id.toString(), name: r.name, assetId: r.assetId?.toString() || null, functionId: r.functionId?.toString() || null,
    recoveryTimeObjectiveHours: r.recoveryTimeObjectiveHours, recoveryPointObjectiveHours: r.recoveryPointObjectiveHours,
    backupDependency: r.backupDependency, restorationProcedure: r.restorationProcedure,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const [runbooks, needingAttention] = await Promise.all([listRunbooks(orgId), listRunbooksNeedingAttention(orgId)]);
    const attentionByRunbookId = new Map(needingAttention.map((a) => [a.runbook._id.toString(), a.reason]));
    return NextResponse.json({ runbooks: runbooks.map((r) => ({ ...serialize(r), attentionReason: attentionByRunbookId.get(r._id.toString()) || null })) });
  } catch (err) {
    console.error("orgs/dr-runbooks GET failed:", err);
    return NextResponse.json({ error: "Could not fetch DR runbooks." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, name, restorationProcedure } = body;
    if (!orgId || !name || !restorationProcedure) return NextResponse.json({ error: "orgId, name, and restorationProcedure are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createRunbook({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ runbook: serialize(result.runbook) });
  } catch (err) {
    console.error("orgs/dr-runbooks POST failed:", err);
    return NextResponse.json({ error: "Could not create DR runbook." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, runbookId, updates } = await req.json();
    if (!orgId || !runbookId) return NextResponse.json({ error: "orgId and runbookId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updateRunbook({ orgId, runbookId, updates: updates || {}, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ runbook: serialize(result.runbook) });
  } catch (err) {
    console.error("orgs/dr-runbooks PATCH failed:", err);
    return NextResponse.json({ error: "Could not update DR runbook." }, { status: 500 });
  }
}
