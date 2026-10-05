// GET /api/public/v1/compliance/controls[?family=&implementation=&evidence=&responsibility=&owner=&q=]   control status with computed evidence state (read-only). Requires FEATURE_COMPLIANCE_READINESS.
import { listControls } from "../../../../../../lib/compliance/implementation.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_COMPLIANCE_READINESS" }, ({ orgId, membership, query }) => listControls({ orgId, membership, family: query.family, implementation: query.implementation, evidence: query.evidence, responsibility: query.responsibility, owner: query.owner, q: query.q }));
