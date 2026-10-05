// app/api/orgs/devices/heartbeat/route.js -- POST { deviceId, platform, name, appVersion, osVersion, encryption:{webcrypto,secureStorage,deviceLock}, cache:{items,bytes}, acks:[commandIds] }
// -> { status:{trust,restricted,syncDisabled}, commands:[{id,type}] }. 403 DEVICE_BLOCKED when the device was blocked or removed (its session is ended).
import * as D from "../../../../../lib/devices/devices.js";
import { deviceRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const POST = (req, ctx) => deviceRoute(req, ctx, ({ orgId, email, body, ip, sessionToken }) => D.heartbeat({ orgId, email, sessionToken, ip, report: body, acks: body.acks }));
