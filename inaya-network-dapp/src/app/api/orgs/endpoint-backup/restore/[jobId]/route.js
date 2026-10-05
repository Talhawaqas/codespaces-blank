// GET ?report=1  recovery report (JSON + Markdown)   POST { action: approve | reject | report, ...result }
import * as B from "../../../../../../lib/endpoint/backup.js";
import { route, json } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, email, membership, params }) => B.recoveryReport({ orgId, email, membership, jobId: params.jobId }));
export const POST = (req, ctx) => route(req, ctx, ({ orgId, email, membership, body, params }) => {
  if (body.action === "approve" || body.action === "reject") return B.decideRestore({ orgId, membership, actorEmail: email, jobId: params.jobId, approve: body.action === "approve" });
  if (body.action === "report") return B.reportRestore({ orgId, email, jobId: params.jobId, report: body });
  return json({ error: "Unknown action." }, 400);
});
