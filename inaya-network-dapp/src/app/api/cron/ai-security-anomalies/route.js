// GET /api/cron/ai-security-anomalies -- every 15 minutes (vercel.json). For each organization with
// recent non-ALLOW AI security events, runs the anomaly detector and notifies owners/admins of
// MEDIUM/HIGH findings. Notifications are deduplicated per finding per hour, so a sustained spike
// alerts once, not every run.

import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getOrgCollections } from "../../../../lib/orgs.js";
import { analyzeOrg } from "../../../../lib/aiSecurity/anomaly.js";
import { createNotification } from "../../../../lib/notifications.js";

const NOTIFY_SEVERITIES = new Set(["HIGH", "MEDIUM"]);

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { aiSecurityChecks, orgMembers } = await getOrgCollections();
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const orgIds = (await aiSecurityChecks.distinct("orgId", { orgId: { $ne: null }, decision: { $ne: "ALLOW" }, timestamp: { $gte: since } }));
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    let notified = 0;
    const results = [];

    for (const orgId of orgIds) {
      const report = await analyzeOrg({ orgId });
      const important = report.anomalies.filter((a) => NOTIFY_SEVERITIES.has(a.severity));
      results.push({ orgId: String(orgId), anomalies: report.anomalies.length, important: important.length });
      if (!important.length) continue;
      const managers = await orgMembers.find({ orgId, role: { $in: ["owner", "admin"] }, status: "active" }).toArray();
      for (const a of important) {
        const key = `${a.type}:${a.actor || a.category || "org"}`;
        for (const m of managers) {
          await createNotification({
            scope: "org", orgId: String(orgId), targetEmail: m.email, category: "aiSecurity", severity: a.severity === "HIGH" ? "critical" : "warning",
            type: "ai_security_anomaly", title: `AI security alert: ${a.type.replace(/_/g, " ").toLowerCase()}`, body: a.message,
            sourceModule: "ai-security", sourceId: key, actionUrl: "/business?view=aiSecurity",
            dedupeKey: `${orgId}:ai_anomaly:${key}:${hourBucket}:${m.email}`,
          });
          notified += 1;
        }
      }
    }
    console.log("[ai-security-anomalies]", JSON.stringify({ orgs: orgIds.length, notified }));
    return NextResponse.json({ success: true, orgsChecked: orgIds.length, notified, results });
  } catch (err) {
    console.error("cron/ai-security-anomalies failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
