// GET ?profileId   recent runs      POST { profileId, status, files, errors, manifest, retryQueue, startedAt, finishedAt }   a client reports a finished run
import * as B from "../../../../../lib/endpoint/backup.js";
import { route } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, email, membership, query }) => B.listRuns({ orgId, email, membership, profileId: query.profileId }));
export const POST = (req, ctx) => route(req, ctx, ({ orgId, email, body }) => B.reportRun({ orgId, email, report: body }));
