// app/api/orgs/migrations/route.js
// GET  ?orgId=&status= -> list migration runs
// POST { orgId, recordType, sourceLabel, records } -> plan a migration (validates only, writes nothing yet)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { planMigration, listMigrations } from "../../../../lib/migration.js";

function serialize(m) {
  return { id: m._id.toString(), recordType: m.recordType, source: m.source, destination: m.destination, status: m.status, recordsTotal: m.recordsTotal, failures: m.failures, reconciliation: m.reconciliation, plannedByEmail: m.plannedByEmail, approvedByEmail: m.approvedByEmail, completedAt: m.completedAt, createdAt: m.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const migrations = await listMigrations(orgId, { status: searchParams.get("status") || undefined });
    return NextResponse.json({ migrations: migrations.map(serialize) });
  } catch (err) {
    console.error("orgs/migrations GET failed:", err);
    return NextResponse.json({ error: "Could not fetch migration runs." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, recordType, records } = body;
    if (!orgId || !recordType || !records) return NextResponse.json({ error: "orgId, recordType, and records are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await planMigration({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ migration: serialize(result.migration) });
  } catch (err) {
    console.error("orgs/migrations POST failed:", err);
    return NextResponse.json({ error: "Could not plan the migration." }, { status: 500 });
  }
}
