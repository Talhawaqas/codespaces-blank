// app/api/meet/rooms/[roomId]/signal/route.js -- Inaya Meet signaling (FEATURE_MEET). No session
// required: a guest with no Inaya account must be able to exchange SDP/ICE too. Caller identity is
// always participantId + (session email OR guestToken) -- see src/lib/meet/signaling.js.
//   GET  ?orgId&participantId&guestToken?&since&wait&cursorSeq   long-poll sync (SDP/ICE/control events)
//   POST { orgId, participantId, guestToken?, kind, payload, toParticipantId? }   send one signal
import * as signaling from "../../../../../../lib/meet/signaling.js";
import { meetOpenRoute } from "../../_lib.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = (req, ctx) =>
  meetOpenRoute(req, ctx, ({ email, params, query }) =>
    signaling.longPollSync({ roomId: params.roomId, participantId: query.participantId, email, guestToken: query.guestToken, since: query.since || null, waitMs: query.wait, cursorSeq: query.cursorSeq })
  );

export const POST = (req, ctx) =>
  meetOpenRoute(req, ctx, ({ email, params, body }) =>
    signaling.postSignal({ roomId: params.roomId, participantId: body.participantId, email, guestToken: body.guestToken, kind: body.kind, payload: body.payload, toParticipantId: body.toParticipantId })
  );
