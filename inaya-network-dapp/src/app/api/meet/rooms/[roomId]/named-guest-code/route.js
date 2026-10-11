// app/api/meet/rooms/[roomId]/named-guest-code/route.js -- Inaya Meet (FEATURE_MEET). No session
// required: a guest with no Inaya account requests this before they have joined anything.
//   POST { orgId, joinToken, email }   always returns { sent: true } regardless of eligibility
// (never reveals whether an address is on the invite list -- same discipline as
// sharing/shares.js's own requestShareCode, which this mirrors).
import * as rooms from "../../../../../../lib/meet/rooms.js";
import { meetOpenRoute } from "../../_lib.js";

export const dynamic = "force-dynamic";

export const POST = (req, ctx) =>
  meetOpenRoute(req, ctx, ({ orgId, params, body }) =>
    rooms.requestNamedGuestCode({ orgId, roomId: params.roomId, joinToken: body.joinToken, email: body.email })
  );
