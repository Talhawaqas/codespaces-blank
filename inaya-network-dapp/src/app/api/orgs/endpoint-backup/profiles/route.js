// GET ?orgId[&scope=mine|org]   POST { name, folders:[{path,include,exclude}], schedule, bandwidthKbps, retention:{versions,days}, bucket, prefix, mode, confirmMirrorDeletes, deviceId }
import * as B from "../../../../../lib/endpoint/backup.js";
import { route } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, email, membership, query }) => B.listProfiles({ orgId, email, membership, scope: query.scope }));
export const POST = (req, ctx) => route(req, ctx, ({ orgId, email, membership, body }) => { const { orgId: _o, ...input } = body; return B.createProfile({ orgId, email, membership, input }); });
