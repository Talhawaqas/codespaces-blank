// app/api/orgs/chat/contacts/requests/[requestId]/deny/route.js -- Secure Chat (see docs/architecture/e2ee-chat-key-management.md). Generated shape: auth, flag and error handling live in chat/_lib.js.
import { chatRoute } from "../../../../_lib.js";
import { fail } from "../../../../../../../../lib/chat/common.js";
import { canManageOrg } from "../../../../../../../../lib/orgs.js";
import * as conv from "../../../../../../../../lib/chat/conversations.js";
import * as devices from "../../../../../../../../lib/chat/devices.js";
import * as contacts from "../../../../../../../../lib/chat/contacts.js";
import * as presence from "../../../../../../../../lib/chat/presence.js";
import * as transport from "../../../../../../../../lib/chat/transport.js";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req, routeCtx) {
  return chatRoute(req, routeCtx, async ({ orgId, membership, email, deviceId, body, query, params }) => {
    return contacts.denyRequest({ email, requestId: params.requestId });
  });
}
