// app/api/orgs/chat/stream/route.js -- Secure Chat (see docs/architecture/e2ee-chat-key-management.md). Generated shape: auth, flag and error handling live in chat/_lib.js.
import { chatRoute } from "../_lib.js";
import { fail } from "../../../../../lib/chat/common.js";
import { canManageOrg } from "../../../../../lib/orgs.js";
import * as conv from "../../../../../lib/chat/conversations.js";
import * as devices from "../../../../../lib/chat/devices.js";
import * as contacts from "../../../../../lib/chat/contacts.js";
import * as presence from "../../../../../lib/chat/presence.js";
import * as transport from "../../../../../lib/chat/transport.js";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req, routeCtx) {
  return chatRoute(req, routeCtx, async ({ orgId, membership, email, deviceId, body, query, params }) => {
    const d = deviceId; if (!d) fail(400, "A device is required (x-inaya-device header or deviceId)."); if (!(await devices.getActiveDevice({ orgId, email, deviceId: d }))) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  const body2 = transport.eventStream({ orgId, email, deviceId: d, since: query.since || null, signal: req.signal });
  return new Response(body2, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  });
}
