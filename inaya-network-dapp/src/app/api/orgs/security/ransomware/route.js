// app/api/orgs/security/ransomware/route.js -- cloud-file ransomware signals (FEATURE_RANSOMWARE_SIGNALS), owner/admin.
//   GET [?state=open|acknowledged|resolved]   signals, active containments, policy
//   POST { action, ... }   policy {enabled,autoContainLevel,containMinutes,thresholds} | resolve {signalId,resolution,note} | lift {actorKey}
//                          | rollbackPreview {actorKey,since} | rollbackExecute {items:[{bucket,key,versionId}]} | tripwire {bucket} | incident {signalId}
import * as R from "../../../../../lib/ransomware/cloud.js";
import { route, json } from "./_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, membership, query }) => R.listSignals({ orgId, membership, state: query.state || null }));
export const POST = (req, ctx) => route(req, ctx, async ({ orgId, membership, email, body }) => {
  const a = { orgId, membership };
  switch (body.action) {
    case "policy": return R.setPolicy({ ...a, actorEmail: email, enabled: body.enabled, autoContainLevel: body.autoContainLevel, containMinutes: body.containMinutes, thresholds: body.thresholds || {} });
    case "resolve": return R.resolveSignal({ ...a, actorEmail: email, signalId: body.signalId, resolution: body.resolution, note: body.note });
    case "lift": return R.liftContainment({ ...a, actorEmail: email, actorKey: body.actorKey });
    case "rollbackPreview": return R.rollbackPreview({ ...a, actorKey: body.actorKey, sinceIso: body.since });
    case "rollbackExecute": return R.rollbackExecute({ ...a, actorEmail: email, items: body.items });
    case "tripwire": return R.placeCanary({ ...a, actorEmail: email, bucket: body.bucket });
    case "incident": return R.incidentReport({ ...a, signalId: body.signalId });
    default: return json({ error: "Unknown action." }, 400);
  }
});
