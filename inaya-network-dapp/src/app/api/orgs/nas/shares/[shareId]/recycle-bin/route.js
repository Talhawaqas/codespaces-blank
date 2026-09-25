// app/api/orgs/nas/shares/[shareId]/recycle-bin/route.js
// GET ?orgId= -> real recycle-bin listing from the appliance (Samba's vfs_recycle module)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { listRecycleBin } from "../../../../../../../lib/nas/shares.js";

export async function GET(req, { params }) {
  try {
    const { shareId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listRecycleBin({ orgId, shareId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/nas/shares/[shareId]/recycle-bin GET failed:", err);
    return NextResponse.json({ error: "Could not list recycle bin." }, { status: 500 });
  }
}
