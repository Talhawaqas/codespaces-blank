// app/api/orgs/chat/conversations/route.js -- Secure Chat (see docs/architecture/e2ee-chat-key-management.md). Generated shape: auth, flag and error handling live in chat/_lib.js.
import { chatRoute } from "../_lib.js";
import { fail } from "../../../../../lib/chat/common.js";
import { canManageOrg } from "../../../../../lib/orgs.js";
import * as conv from "../../../../../lib/chat/conversations.js";
import * as devices from "../../../../../lib/chat/devices.js";
import * as contacts from "../../../../../lib/chat/contacts.js";
import * as presence from "../../../../../lib/chat/presence.js";
import * as transport from "../../../../../lib/chat/transport.js";

const parseCursors = (s) => { try { const o = JSON.parse(s || "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; } };
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req, routeCtx) {
  return chatRoute(req, routeCtx, async ({ orgId, membership, email, deviceId, body, query, params }) => {
    const d = deviceId; if (!d) fail(400, "A device is required (x-inaya-device header or deviceId)."); return transport.longPollSync({ orgId, email, deviceId: d, cursors: parseCursors(query.cursors), since: query.since || null, waitMs: query.wait });
  });
}

export async function POST(req, routeCtx) {
  return chatRoute(req, routeCtx, async ({ orgId, membership, email, deviceId, body, query, params }) => {
    const d = deviceId; if (!d) fail(400, "A device is required (x-inaya-device header or deviceId)."); return conv.createConversation({ orgId, membership, email, deviceId: d, conversationId: body.conversationId, kind: body.kind, emails: body.emails, external: !!body.external });
  });
}
