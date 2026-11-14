// GET   /api/public/v1/appointments/{id}
// PATCH /api/public/v1/appointments/{id} { status: CONFIRMED|COMPLETED|NO_SHOW|CANCELLED, reason?, outcome? } | { start } (reschedule)
import * as A from "../../../../../../lib/engagement/appointments.js";
import { publicRoute } from "../../_lib.js";
import { unwrap, gate } from "../../_engagement.js";
export const dynamic = "force-dynamic";

export const GET = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, membership, params }) => {
  await gate(orgId, "appointments");
  return unwrap(await A.getAppointment({ orgId, membership, appointmentId: params.appointmentId }));
});

export const PATCH = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, membership, email, body, params }) => {
  await gate(orgId, "appointments");
  if (body.start) return unwrap(await A.rescheduleAppointment({ orgId, membership, actorEmail: email, appointmentId: params.appointmentId, start: body.start }));
  return unwrap(await A.transitionAppointment({ orgId, membership, actorEmail: email, appointmentId: params.appointmentId, toStatus: body.status, reason: body.reason, outcome: body.outcome }));
});
