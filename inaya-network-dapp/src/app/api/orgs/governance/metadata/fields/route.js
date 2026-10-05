// app/api/orgs/governance/metadata/fields/route.js
//   GET                         fields you may see (built-in + custom)
//   POST { key,label,type,options,required,visibility,editableBy }   define a field (owner/admin)
//   DELETE ?key=                archive a field (values are kept)
import * as M from "../../../../../../lib/governance/metadata.js";
import { govRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
const F = "FEATURE_FILE_GOVERNANCE";
export const GET = (req, ctx) => govRoute(req, ctx, F, async ({ orgId, membership }) => ({ fields: await M.listFields({ orgId, membership }), sets: await M.listSets({ orgId }) }));
export const POST = (req, ctx) => govRoute(req, ctx, F, ({ orgId, membership, email, body }) => { const { orgId: _o, ...rest } = body; return M.defineField({ orgId, actorEmail: email, membership, ...rest }); });
export const DELETE = (req, ctx) => govRoute(req, ctx, F, ({ orgId, membership, email, query }) => M.archiveField({ orgId, actorEmail: email, membership, key: query.key }));
