// app/api/meet/rooms/[roomId]/participants/route.js -- Inaya Meet (FEATURE_MEET).
//   GET ?orgId[&waiting=1]   admitted participants (any admitted participant/host), or the waiting-room list (host/moderator only)
import * as rooms from "../../../../../../lib/meet/rooms.js";
import { meetRoute } from "../../_lib.js";

export const dynamic = "force-dynamic";

export const GET = (req, ctx) =>
  meetRoute(req, ctx, ({ orgId, membership, email, params, query }) =>
    query.waiting
      ? rooms.listWaiting({ orgId, membership, actorEmail: email, roomId: params.roomId })
      : rooms.listParticipants({ orgId, membership, email, roomId: params.roomId })
  );
