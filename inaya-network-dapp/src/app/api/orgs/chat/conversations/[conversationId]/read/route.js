// app/api/orgs/chat/conversations/[conversationId]/read/route.js -- Secure Chat (see docs/architecture/e2ee-chat-key-management.md). Generated shape: auth, flag and error handling live in chat/_lib.js.
import { chatRoute } from "../../../_lib.js";
import { fail } from "../../../../../../../lib/chat/common.js";
import { canManageOrg } from "../../../../../../../lib/orgs.js";
import * as conv from "../../../../../../../lib/chat/conversations.js";
import * as devices from "../../../../../../../lib/chat/devices.js";
import * as contacts from "../../../../../../../lib/chat/contacts.js";
import * as presence from "../../../../../../../lib/chat/presence.js";
import * as transport from "../../../../../../../lib/chat/transport.js";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req, routeCtx) {
  return chatRoute(req, routeCtx, async ({ orgId, membership, email, deviceId, body, query, params }) => {
    return conv.markRead({ orgId, email, conversationId: params.conversationId, seq: body.seq });
  });
}

export async function GET(req, routeCtx) {
  return chatRoute(req, routeCtx, async ({ orgId, membership, email, deviceId, body, query, params }) => {
    return { receipts: await conv.readReceipts({ orgId, email, conversationId: params.conversationId }) };
  });
}
