// app/api/meet/rooms/route.js -- Inaya Meet (FEATURE_MEET).
//   GET  ?orgId[&scope=mine|org]   your own meetings (hosted or joined), or (admin) every meeting in the org
//   POST { orgId, title, kind, scheduledStart?, scheduledEnd?, policy?, inviteEmails?, deviceId? }   create an instant or scheduled meeting
import * as rooms from "../../../../lib/meet/rooms.js";
import { meetRoute } from "./_lib.js";

export const dynamic = "force-dynamic";

export const GET = (req, ctx) =>
  meetRoute(req, ctx, ({ orgId, membership, email, query }) =>
    rooms.listRooms({ orgId, membership, email, scope: query.scope })
  );

export const POST = (req, ctx) =>
  meetRoute(req, ctx, ({ orgId, membership, email, body }) =>
    rooms.createRoom({ orgId, membership, hostEmail: email, deviceId: body.deviceId, title: body.title, kind: body.kind, scheduledStart: body.scheduledStart, scheduledEnd: body.scheduledEnd, policy: body.policy, inviteEmails: body.inviteEmails })
  );
