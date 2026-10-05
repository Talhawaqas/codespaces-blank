// app/api/orgs/governance/classification/rules/route.js -- the published classification rules, so a browser or customer scanner can classify content locally.
import * as K from "../../../../../../lib/governance/classification.js";
import { govRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => govRoute(req, ctx, "FEATURE_SMART_CLASSIFICATION", async ({ orgId, membership, email }) => ({ rules: await K.rulesForClients({ orgId, ctx: { email, role: membership.role } }) }));
