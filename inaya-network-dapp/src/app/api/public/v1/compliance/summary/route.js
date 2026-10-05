// GET /api/public/v1/compliance/summary   readiness overview by control family (read-only). Requires FEATURE_COMPLIANCE_READINESS. Readiness only: never a certification.
import { summary } from "../../../../../../lib/compliance/implementation.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_COMPLIANCE_READINESS" }, ({ orgId, membership }) => summary({ orgId, membership }));
