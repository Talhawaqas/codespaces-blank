// GET /api/cron/ha-gateway -- hourly (CRON_SECRET bearer): expire finished-with Office edit sessions, alert administrators when an organization's secondary site falls behind its RPO target,
// and when a registered gateway has gone quiet for more than ten minutes (once per day per gateway).
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getOrgCollections } from "../../../../lib/orgs.js";
import { expireSessions } from "../../../../lib/integrations/office.js";
import { checkAndAlert } from "../../../../lib/ha/replication.js";
import { alertOfflineGateways } from "../../../../lib/gateway/health.js";
import { withJobRun } from "../../../../lib/jobs/run.js";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try {
    // platform-wide pieces run once; the replication check runs per organization as its own tenant-scoped job, so one organization failing never stops or repeats another
    const base = await withJobRun({ name: "ha-gateway", staleSeconds: 1800, fn: async () => ({ sessions: await expireSessions(), gateways: await alertOfflineGateways() }) });
    const { db } = await getOrgCollections(); const rep = { orgs: 0, alerted: 0, failed: 0, skipped: 0 };
    for (const p of await db.collection("ha_profiles").find({}).project({ orgId: 1 }).limit(200).toArray()) { rep.orgs++; const r = await withJobRun({ name: "ha-replication-check", orgId: String(p.orgId), staleSeconds: 1800, minIntervalSeconds: 3000, retries: 1, fn: () => checkAndAlert({ orgId: String(p.orgId) }) }); if (r.status === "succeeded") rep.alerted += r.result.alerted; else if (r.status === "failed") rep.failed++; else rep.skipped++; }
    return NextResponse.json({ success: base.status !== "failed" && rep.failed === 0, platform: base.status, ...(base.result || {}), replication: rep });
  } catch (err) { console.error("cron/ha-gateway failed:", err); return NextResponse.json({ success: false, error: "Job failed." }, { status: 500 }); }
}
