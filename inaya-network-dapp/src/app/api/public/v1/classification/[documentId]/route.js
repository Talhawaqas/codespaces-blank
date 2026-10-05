// GET  /api/public/v1/classification/{documentId}   the classification history of one document
// POST /api/public/v1/classification/{documentId}   { dryRun?: false } evaluate the organization's rules against the document's metadata (no file content is
//   sent or read). dryRun defaults to true, so the document is only changed when the caller says so explicitly. Requires FEATURE_SMART_CLASSIFICATION.
//   Changing a level by hand stays in the app, where a reason and the approval rules apply.
import * as C from "../../../../../../lib/governance/classification.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
const F = { flag: "FEATURE_SMART_CLASSIFICATION" };
export const GET = (req, ctx) => publicRoute(req, ctx, F, ({ orgId, membership, email, params, query }) => C.classificationHistory({ orgId, documentId: params.documentId, membership, email, limit: query.limit }));
export const POST = (req, ctx) => publicRoute(req, ctx, F, ({ orgId, membership, email, params, body }) => C.classifyDocument({ orgId, documentId: params.documentId, membership, email, source: "rules", dryRun: body.dryRun !== false }));
