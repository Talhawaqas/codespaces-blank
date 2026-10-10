// app/api/meet/rooms/[roomId]/stream/route.js -- Inaya Meet signaling, SSE variant (FEATURE_MEET).
// Same auth as signal/route.js (no session required -- a guest participates too).
//   GET ?orgId&participantId&guestToken?&since
import { eventStream } from "../../../../../../lib/meet/signaling.js";
import { meetOpenRoute } from "../../_lib.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = (req, ctx) =>
  meetOpenRoute(req, ctx, ({ email, params, query }) => {
    const body = eventStream({ roomId: params.roomId, participantId: query.participantId, email, guestToken: query.guestToken, since: query.since || null, signal: req.signal });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  });
