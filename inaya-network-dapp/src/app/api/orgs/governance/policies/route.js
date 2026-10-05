// app/api/orgs/governance/policies/route.js
//   GET  ?orgId[&type&status]   list every version (owner/admin)
//   POST { orgId, type, name, scope, precedence, priority, effectiveAt, expiresAt, approvalRequired, config }   create a draft
import * as P from "../../../../../lib/governance/policies.js";
import { govRoute, flagForType } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => govRoute(req, ctx, null, async ({ orgId, membership, query }) => ({ policies: await P.listPolicies({ orgId, membership, type: query.type || null, status: query.status || null }), types: Object.entries(P.POLICY_TYPES).map(([k, v]) => ({ type: k, label: v.label })) }));
export const POST = (req, ctx) => govRoute(req, ctx, null, async ({ orgId, membership, email, body, flagCheck }) => { await flagCheck(flagForType(body.type)); const { orgId: _o, ...rest } = body; return P.createPolicy({ orgId, actorEmail: email, membership, ...rest }); });
