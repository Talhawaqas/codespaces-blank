// app/api/orgs/storage/overview/route.js
//
// GET /api/orgs/storage/overview?orgId=
// The Storage Manager dashboard's primary payload. See
// storage-manager.js's getOrgStorageOverview() header comment for exactly
// what's real vs. unsupported.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessStorage } from "../../../../../lib/orgs.js";
import { getOrgStorageOverview } from "../../../../../lib/storage-manager.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessStorage(auth.membership)) return NextResponse.json({ error: "You don't have storage-infrastructure access." }, { status: 403 });

    const overview = await getOrgStorageOverview(orgId);
    return NextResponse.json(overview);
  } catch (err) {
    console.error("orgs/storage/overview GET failed:", err);
    return NextResponse.json({ error: "Could not load the storage overview." }, { status: 500 });
  }
}
