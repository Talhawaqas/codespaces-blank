// GET [?status]   restore jobs      POST { profileId, selection:{prefix,paths}, pointInTime, target:original|alternate, alternatePath, overwrite, reason }
import * as B from "../../../../../lib/endpoint/backup.js";
import { route } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, email, membership, query }) => B.listRestoreJobs({ orgId, email, membership, status: query.status || null }));
export const POST = (req, ctx) => route(req, ctx, ({ orgId, email, membership, body }) => { const { orgId: _o, ...input } = body; return B.createRestoreJob({ orgId, email, membership, ...input }); });
