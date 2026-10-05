// GET /api/public/v1/governance/dlp-events[?decision=&action=&limit=&before=]   data-loss-prevention decisions (read-only). Requires FEATURE_DLP.
import { listDlpEvents } from "../../../../../../lib/governance/dlp.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_DLP" }, ({ orgId, membership, query }) => listDlpEvents({ orgId, membership, decision: query.decision || null, action: query.action || null, limit: query.limit, before: query.before || null }));
