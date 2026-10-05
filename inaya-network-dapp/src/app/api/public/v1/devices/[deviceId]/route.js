// GET  /api/public/v1/devices/{deviceId}   one device
// POST /api/public/v1/devices/{deviceId}   { action }  trust | untrust | block | unblock | revoke | signout | reauth | wipe_cache | disable_sync | enable_sync
//   (wipe_cache asks the app to clear its own local app data; it never touches the person's other files)
import * as D from "../../../../../../lib/devices/devices.js";
import { publicRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
const F = { flag: "FEATURE_DEVICE_CONTROL" };
export const GET = (req, ctx) => publicRoute(req, ctx, F, ({ orgId, membership, email, params }) => D.getDevice({ orgId, membership, actorEmail: email, deviceId: params.deviceId }));
export const POST = (req, ctx) => publicRoute(req, ctx, F, ({ orgId, membership, email, body, params }) => D.deviceAction({ orgId, membership, actorEmail: email, deviceId: params.deviceId, action: body.action }));
