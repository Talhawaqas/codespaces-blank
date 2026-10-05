// app/api/orgs/governance/dlp/approvals/route.js
//   GET ?status=pending|approved|denied|used     POST { approvalId, approve }   (owner/admin; never your own request)
import * as D from "../../../../../../lib/governance/dlp.js";
import { govRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => govRoute(req, ctx, "FEATURE_DLP", ({ orgId, membership, query }) => D.listApprovals({ orgId, membership, status: query.status === "all" ? null : query.status || "pending" }));
export const POST = (req, ctx) => govRoute(req, ctx, "FEATURE_DLP", ({ orgId, membership, email, body }) => D.decideDlpApproval({ orgId, approvalId: body.approvalId, membership, approverEmail: email, approve: !!body.approve }));
