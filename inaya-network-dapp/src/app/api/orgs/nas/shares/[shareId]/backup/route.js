// app/api/orgs/nas/shares/[shareId]/backup/route.js
// POST { orgId } -> runs a real backup of every file on the share into Inaya (reuses the s3-compat pipeline)
// GET ?orgId= -> lists past backup runs

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { backupShareToInaya, listBackupRuns } from "../../../../../../../lib/nas/backup.js";

export async function POST(req, { params }) {
  try {
    const { shareId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await backupShareToInaya({ orgId, shareId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/shares/[shareId]/backup POST failed:", err);
    return NextResponse.json({ error: "Backup failed." }, { status: 500 });
  }
}

export async function GET(req, { params }) {
  try {
    const { shareId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listBackupRuns({ orgId, shareId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/shares/[shareId]/backup GET failed:", err);
    return NextResponse.json({ error: "Could not list backup runs." }, { status: 500 });
  }
}
