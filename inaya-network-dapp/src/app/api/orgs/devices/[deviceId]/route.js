// app/api/orgs/devices/[deviceId]/route.js
//   GET                one device       POST { action }   trust | untrust | block | unblock | revoke | signout | reauth | wipe_cache | disable_sync | enable_sync
//   (the person who owns a device may revoke, sign out, re-authenticate or wipe their own; everything else needs owner/admin)
import * as D from "../../../../../lib/devices/devices.js";
import { deviceRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => deviceRoute(req, ctx, ({ orgId, membership, email, params }) => D.getDevice({ orgId, membership, actorEmail: email, deviceId: params.deviceId }));
export const POST = (req, ctx) => deviceRoute(req, ctx, ({ orgId, membership, email, body, params }) => D.deviceAction({ orgId, membership, actorEmail: email, deviceId: params.deviceId, action: body.action }));
