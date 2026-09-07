// app/api/orgs/migrations/[migrationId]/route.js
// GET   ?orgId= -> migration run detail
// PATCH { orgId, action, reason? } -> action: "approve" | "reject" | "execute"

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getMigration, approveMigration, rejectMigration, executeMigration } from "../../../../../lib/migration.js";

function serialize(m) {
  return { id: m._id.toString(), recordType: m.recordType, source: m.source, destination: m.destination, status: m.status, recordsTotal: m.recordsTotal, failures: m.failures, reconciliation: m.reconciliation, plannedByEmail: m.plannedByEmail, approvedByEmail: m.approvedByEmail, completedAt: m.completedAt, createdAt: m.createdAt };
}

export async function GET(req, { params }) {
  try {
    const { migrationId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const migration = await getMigration(orgId, migrationId);
    if (!migration) return NextResponse.json({ error: "Migration run not found." }, { status: 404 });
    return NextResponse.json({ migration: serialize(migration) });
  } catch (err) {
    console.error("orgs/migrations/[migrationId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the migration run." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { migrationId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const ctx = { orgId, migrationId, actorEmail: auth.session.email, membership: auth.membership };
    const fn = { approve: approveMigration, reject: () => rejectMigration({ ...ctx, reason: body.reason }), execute: executeMigration }[action];
    if (!fn) return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });

    const result = await fn(ctx);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ migration: serialize(result.migration) });
  } catch (err) {
    console.error("orgs/migrations/[migrationId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the migration run." }, { status: 500 });
  }
}
