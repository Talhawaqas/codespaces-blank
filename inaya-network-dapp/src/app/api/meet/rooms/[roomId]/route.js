// app/api/meet/rooms/[roomId]/route.js -- Inaya Meet (FEATURE_MEET).
//   GET   ?orgId   meeting details (host, an admitted/waiting participant, or an org admin only)
//   PATCH { orgId, ...policy fields }   update the meeting's policy (host/moderator or org admin)
import * as rooms from "../../../../../lib/meet/rooms.js";
import { meetRoute, meetOpenRoute } from "../_lib.js";

export const dynamic = "force-dynamic";

// GET is open (a guest has no org session) -- guest identity comes from participantId+guestToken
// query params instead; rooms.getRoom() checks both paths and fails closed either way (§7.35).
export const GET = (req, ctx) =>
  meetOpenRoute(req, ctx, ({ orgId, membership, email, params, query }) =>
    rooms.getRoom({ orgId, membership, email, roomId: params.roomId, participantId: query.participantId, guestToken: query.guestToken })
  );

export const PATCH = (req, ctx) =>
  meetRoute(req, ctx, ({ orgId, membership, email, params, body }) =>
    rooms.updatePolicy({ orgId, membership, actorEmail: email, roomId: params.roomId, patch: body })
  );
