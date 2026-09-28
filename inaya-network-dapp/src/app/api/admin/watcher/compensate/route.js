// app/api/admin/watcher/compensate/route.js
//
// GET  /api/admin/watcher/compensate  — full compensation grant history
// POST /api/admin/watcher/compensate  — credit one wallet, with a reason
//
// Private, owner-only — same cookie-based admin session as
// /api/admin/dashboard (admin-auth.js). Built for SQA-037: with no
// recoverable history for a wallet's pre-incident points, this is how an
// admin credits it back based on whatever the user can show, with a
// permanent, honest record of exactly what was granted and why — never a
// silent database edit.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { ensureWatcherIndexes, grantCompensationPoints, listCompensationGrants } from "../../../../../lib/watcherPioneer.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await ensureWatcherIndexes();
    const grants = await listCompensationGrants();
    return NextResponse.json({ grants });
  } catch (err) {
    console.error("admin/watcher/compensate GET failed:", err);
    return NextResponse.json({ error: "Could not load compensation history." }, { status: 500 });
  }
}

export async function POST(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { walletAddress, points, reason, grantedBy } = await req.json();
    await ensureWatcherIndexes();
    const result = await grantCompensationPoints({ walletAddress, points, reason, grantedBy });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message || "Could not grant compensation." }, { status: 400 });
  }
}
