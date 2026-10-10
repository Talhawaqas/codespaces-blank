// app/api/meet/rooms/[roomId]/join/route.js -- Inaya Meet (FEATURE_MEET). No session required: a
// guest with the join link and no Inaya account must be able to call this.
//   POST { orgId, joinToken, deviceId?, guestName? }
//     -> an authenticated org member joins with their session email
//     -> everyone else joins as a guest and must supply guestName (rejected unless room.policy.guestAccess allows it)
import * as rooms from "../../../../../../lib/meet/rooms.js";
import { meetOpenRoute } from "../../_lib.js";

export const dynamic = "force-dynamic";

export const POST = (req, ctx) =>
  meetOpenRoute(req, ctx, ({ orgId, email, params, body }) =>
    rooms.requestJoin({ orgId, roomId: params.roomId, joinToken: body.joinToken, email, deviceId: body.deviceId, guestName: body.guestName })
  );
