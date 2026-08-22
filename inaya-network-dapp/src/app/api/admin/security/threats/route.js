// app/api/admin/security/threats/route.js
//
// GET /api/admin/security/threats?status=
//
// isAdminAuthenticated-gated, same as /api/admin/dataroom/* — lists
// threats for the admin Security dashboard, optionally filtered by status
// (0=Unverified 1=Confirmed 2=Disputed 3=Cleared).

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { ensureSecurityIndexes, adminListThreats } from "../../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const status = statusParam != null ? Number(statusParam) : undefined;

    await ensureSecurityIndexes();
    const threats = await adminListThreats({ status });
    return NextResponse.json({ items: threats });
  } catch (err) {
    console.error("admin/security/threats GET failed:", err);
    return NextResponse.json({ error: "Could not load threats." }, { status: 500 });
  }
}
