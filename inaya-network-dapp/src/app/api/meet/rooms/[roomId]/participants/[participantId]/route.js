// app/api/meet/rooms/[roomId]/participants/[participantId]/route.js -- Inaya Meet (FEATURE_MEET).
// Host/moderator-only moderation actions, all server-enforced (never a client-asserted role, SOW §7.12).
//   PATCH { orgId, action: "approve"|"reject"|"remove"|"mute", roomSecretEnvelope?, algorithmId?, reason? }
import * as rooms from "../../../../../../../lib/meet/rooms.js";
import { fail } from "../../../../../../../lib/meet/common.js";
import { meetRoute } from "../../../_lib.js";

export const dynamic = "force-dynamic";

const ACTIONS = {
  approve: ({ orgId, membership, email, params, body }) => rooms.approveParticipant({ orgId, membership, actorEmail: email, roomId: params.roomId, participantId: params.participantId, roomSecretEnvelope: body.roomSecretEnvelope, algorithmId: body.algorithmId }),
  reject: ({ orgId, membership, email, params, body }) => rooms.rejectParticipant({ orgId, membership, actorEmail: email, roomId: params.roomId, participantId: params.participantId, reason: body.reason }),
  remove: ({ orgId, membership, email, params, body }) => rooms.removeParticipant({ orgId, membership, actorEmail: email, roomId: params.roomId, participantId: params.participantId, reason: body.reason }),
  mute: ({ orgId, membership, email, params }) => rooms.muteParticipant({ orgId, membership, actorEmail: email, roomId: params.roomId, participantId: params.participantId }),
};

export const PATCH = (req, ctx) =>
  meetRoute(req, ctx, (args) => {
    const fn = ACTIONS[args.body.action];
    if (!fn) fail(400, `action must be one of: ${Object.keys(ACTIONS).join(", ")}.`);
    return fn(args);
  });
