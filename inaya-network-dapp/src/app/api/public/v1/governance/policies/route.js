// GET /api/public/v1/governance/policies[?type=&status=]   governance policies (read-only; publishing and retiring stay in the app, behind approvals)
import * as P from "../../../../../../lib/governance/policies.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
const flagFor = (t) => (t === "dlp" ? "FEATURE_DLP" : t === "classification" ? "FEATURE_SMART_CLASSIFICATION" : "FEATURE_FILE_GOVERNANCE");
export const GET = (req, ctx) => publicRoute(req, ctx, { flag: flagFor(new URL(req.url).searchParams.get("type")) }, ({ orgId, membership, query }) => P.listPolicies({ orgId, membership, type: query.type || null, status: query.status || null }));
