// app/api/orgs/backup-credentials/route.js
// GET  ?orgId= -> list credentials (secret never returned)
// POST { orgId, provider, label, credentials } -> store one, encrypted at rest

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { storeBackupCredential, listBackupCredentials } from "../../../../lib/backupCryptoAndCredentials.js";

function serialize(c) {
  return { id: c._id.toString(), provider: c.provider, label: c.label, createdByEmail: c.createdByEmail, createdAt: c.createdAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const credentials = await listBackupCredentials(orgId);
    return NextResponse.json({ credentials: credentials.map(serialize) });
  } catch (err) {
    console.error("orgs/backup-credentials GET failed:", err);
    return NextResponse.json({ error: "Could not fetch backup credentials." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, provider, label, credentials } = body;
    if (!orgId || !provider || !credentials) return NextResponse.json({ error: "orgId, provider and credentials are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await storeBackupCredential({ orgId, provider, label, credentials, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ credentialId: result.credentialId.toString(), provider: result.provider, label: result.label });
  } catch (err) {
    console.error("orgs/backup-credentials POST failed:", err);
    return NextResponse.json({ error: "Could not store this backup credential." }, { status: 500 });
  }
}
