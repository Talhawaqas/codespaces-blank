// app/api/meet/rooms/[roomId]/leave/route.js -- Inaya Meet (FEATURE_MEET). No session required: a
// guest leaves with their participantId + guestToken, not an Inaya account.
//   POST { orgId, participantId, guestToken? }
import * as rooms from "../../../../../../lib/meet/rooms.js";
import { meetOpenRoute } from "../../_lib.js";

export const dynamic = "force-dynamic";

export const POST = (req, ctx) =>
  meetOpenRoute(req, ctx, ({ orgId, email, params, body }) =>
    rooms.leaveRoom({ orgId, roomId: params.roomId, participantId: body.participantId, email, guestToken: body.guestToken })
  );
