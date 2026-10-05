// app/api/orgs/governance/metadata/sets/route.js -- POST { key, name, fieldKeys, appliesTo } (owner/admin)
import * as M from "../../../../../../lib/governance/metadata.js";
import { govRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const POST = (req, ctx) => govRoute(req, ctx, "FEATURE_FILE_GOVERNANCE", ({ orgId, membership, email, body }) => { const { orgId: _o, ...rest } = body; return M.defineSet({ orgId, actorEmail: email, membership, ...rest }); });
