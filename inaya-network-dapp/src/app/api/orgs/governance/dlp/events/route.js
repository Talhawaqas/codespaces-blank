// app/api/orgs/governance/dlp/events/route.js -- structured DLP and upload-governance events (owner/admin).
import * as D from "../../../../../../lib/governance/dlp.js";
import { govRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => govRoute(req, ctx, "FEATURE_DLP", ({ orgId, membership, query }) => D.listDlpEvents({ orgId, membership, decision: query.decision || null, action: query.action || null, limit: query.limit, before: query.before || null }));
