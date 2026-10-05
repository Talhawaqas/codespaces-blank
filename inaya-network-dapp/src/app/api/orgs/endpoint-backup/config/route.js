// GET ?deviceId   the profiles a client should run, with mode and limits; also hands out ready restore jobs (POST claims them)
import * as B from "../../../../../lib/endpoint/backup.js";
import { route } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, email, query }) => B.clientConfig({ orgId, email, deviceId: query.deviceId }));
export const POST = (req, ctx) => route(req, ctx, ({ orgId, email, body }) => B.claimRestoreJobs({ orgId, email, deviceId: body.deviceId }));
