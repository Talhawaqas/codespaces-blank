// app/api/orgs/governance/dlp/simulate/route.js -- "what would the current DLP rules do with this?" Evaluates only; records nothing.
import * as D from "../../../../../../lib/governance/dlp.js";
import { GovError } from "../../../../../../lib/governance/policies.js";
import { canManageOrg } from "../../../../../../lib/orgGates.js";
import { govRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const POST = (req, ctx) => govRoute(req, ctx, "FEATURE_DLP", async ({ orgId, membership, email, body }) => {
  if (!canManageOrg(membership)) throw new GovError(403, "Only an owner or admin can simulate rules.");
  const c = body.context && typeof body.context === "object" ? body.context : {};
  return D.evaluateDlp({ orgId, ctx: { email, role: "member", ...c } });
});
