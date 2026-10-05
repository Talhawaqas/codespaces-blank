// GET /api/public/v1/devices   the device inventory. Requires FEATURE_DEVICE_CONTROL.
import * as D from "../../../../../lib/devices/devices.js";
import { publicRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_DEVICE_CONTROL" }, ({ orgId, membership, email }) => D.listDevices({ orgId, membership, email, scope: "org" }));
