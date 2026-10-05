// GET /api/cron/ha-gateway -- hourly (CRON_SECRET bearer): expire finished-with Office edit sessions, alert administrators when an organization's secondary site falls behind its RPO target,
// and when a registered gateway has gone quiet for more than ten minutes (once per day per gateway).
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getOrgCollections } from "../../../../lib/orgs.js";
import { expireSessions } from "../../../../lib/integrations/office.js";
import { checkAndAlert } from "../../../../lib/ha/replication.js";
import { alertOfflineGateways } from "../../../../lib/gateway/health.js";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try {
    const out = { sessions: await expireSessions(), replication: { orgs: 0, alerted: 0 }, gateways: await alertOfflineGateways() };
    const { db } = await getOrgCollections();
    for (const p of await db.collection("ha_profiles").find({}).project({ orgId: 1 }).limit(200).toArray()) { out.replication.orgs++; try { out.replication.alerted += (await checkAndAlert({ orgId: String(p.orgId) })).alerted; } catch { /* one organization failing never stops the rest */ } }
    return NextResponse.json({ success: true, ...out });
  } catch (err) { console.error("cron/ha-gateway failed:", err); return NextResponse.json({ success: false, error: "Job failed." }, { status: 500 }); }
}
