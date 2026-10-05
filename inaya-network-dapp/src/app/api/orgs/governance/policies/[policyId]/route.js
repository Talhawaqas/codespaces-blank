// app/api/orgs/governance/policies/[policyId]/route.js
//   GET                      one version
//   PATCH { ...fields }      edit a DRAFT
//   POST { action }          publish | approve | reject (note) | retire (reason) | newVersion
//   DELETE                   delete a DRAFT
import * as P from "../../../../../../lib/governance/policies.js";
import { govRoute, json } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => govRoute(req, ctx, null, ({ orgId, membership, params }) => P.getPolicy({ orgId, policyId: params.policyId, membership }));
export const PATCH = (req, ctx) => govRoute(req, ctx, null, ({ orgId, membership, email, body, params }) => { const { orgId: _o, ...rest } = body; return P.updateDraft({ orgId, policyId: params.policyId, actorEmail: email, membership, ...rest }); });
export const DELETE = (req, ctx) => govRoute(req, ctx, null, ({ orgId, membership, email, params }) => P.deleteDraft({ orgId, policyId: params.policyId, actorEmail: email, membership }));
export const POST = (req, ctx) => govRoute(req, ctx, null, async ({ orgId, membership, email, body, params }) => {
  const a = { orgId, policyId: params.policyId, actorEmail: email, membership };
  switch (body.action) {
    case "publish": return P.publishPolicy(a);
    case "approve": return P.decideApproval({ ...a, approve: true });
    case "reject": return P.decideApproval({ ...a, approve: false, note: body.note });
    case "retire": return P.retirePolicy({ ...a, reason: body.reason });
    case "newVersion": { const p = await P.getPolicy({ orgId, policyId: params.policyId, membership }); return P.newVersion({ orgId, policyKey: p.policyKey, actorEmail: email, membership }); }
    default: return json({ error: "Unknown action." }, 400);
  }
});
