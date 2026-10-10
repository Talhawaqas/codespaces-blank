// app/api/meet/rooms/[roomId]/lock/route.js -- Inaya Meet (FEATURE_MEET). Host/moderator or org admin.
//   POST { orgId, locked: boolean }
import * as rooms from "../../../../../../lib/meet/rooms.js";
import { meetRoute } from "../../_lib.js";

export const dynamic = "force-dynamic";

export const POST = (req, ctx) =>
  meetRoute(req, ctx, ({ orgId, membership, email, params, body }) =>
    rooms.lockRoom({ orgId, membership, actorEmail: email, roomId: params.roomId, locked: !!body.locked })
  );
