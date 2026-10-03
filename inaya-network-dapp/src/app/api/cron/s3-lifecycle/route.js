// GET /api/cron/s3-lifecycle
// Storj-Inspired Storage Capability Expansion SOW §6 -- lifecycle/retention
// enforcement job. Same Vercel Cron gate convention as
// api/cron/nodes-snapshot/route.js and api/backup/cron/*/route.js
// (Authorization: Bearer $CRON_SECRET) -- this route is only the auth
// check + error boundary, delegating the actual work to
// s3-compat/store.js's runLifecycleEnforcement(). Requires a Vercel Cron
// (or equivalent) entry pointing at this path to actually run on a
// schedule -- that external scheduler config is outside what this
// codebase can install or verify itself; runLifecycleEnforcement() is
// also directly callable on demand (Business Workspace's "Run now").

import { NextResponse } from "next/server";
import { runLifecycleEnforcement } from "../../../../lib/s3-compat/store.js";
import { sweepPendingPurges } from "../../../../lib/s3-compat/purge.js";

import { isAuthorizedCron } from "@/lib/cronAuth";
export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!isAuthorizedCron(authHeader)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runLifecycleEnforcement({});
    // Retry any provider cleanup that failed when an object was deleted (see s3-compat/purge.js).
    const purges = await sweepPendingPurges({});
    return NextResponse.json({ success: true, ...result, purges });
  } catch (err) {
    console.error("cron/s3-lifecycle failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
