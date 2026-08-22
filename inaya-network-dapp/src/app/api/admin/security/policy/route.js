// app/api/admin/security/policy/route.js
//
// GET  /api/admin/security/policy — current policy content + version (admin view, no signature needed here)
// POST /api/admin/security/policy — Body: { content } — publishes a new version
//
// isAdminAuthenticated-gated. Deliberately NOT a rule-builder UI — the
// admin pastes/edits the policy JSON object directly (same "config file,
// not a visual editor" pragmatism as learnConfig.js), and this route
// versions it, hashes it, and anchors the hash on InayaSecurityPolicy.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { ensureSecurityIndexes, getCurrentPolicy, publishPolicy } from "../../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    await ensureSecurityIndexes();
    const policy = await getCurrentPolicy();
    return NextResponse.json(policy);
  } catch (err) {
    console.error("admin/security/policy GET failed:", err);
    return NextResponse.json({ error: "Could not load policy." }, { status: 500 });
  }
}

export async function POST(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { content } = await req.json();
    if (!content || typeof content !== "object") {
      return NextResponse.json({ error: "content (a JSON object) is required." }, { status: 400 });
    }

    await ensureSecurityIndexes();
    const result = await publishPolicy(content);
    return NextResponse.json(result);
  } catch (err) {
    console.error("admin/security/policy POST failed:", err);
    return NextResponse.json({ error: err.message || "Publish failed." }, { status: 500 });
  }
}
