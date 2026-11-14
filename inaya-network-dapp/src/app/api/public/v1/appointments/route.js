// GET  /api/public/v1/appointments?from&to&status&staffEmail&contactId   appointments in the organization (team view)
// POST /api/public/v1/appointments { typeId, start, customer{name,email,phone}, staffEmail?, note?, timeZone? }
//   books through the same availability and double-booking checks as the booking page; confirmation email + invite are sent.
import * as A from "../../../../../lib/engagement/appointments.js";
import { publicRoute } from "../_lib.js";
import { unwrap, gate } from "../_engagement.js";
export const dynamic = "force-dynamic";

export const GET = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, membership, query }) => {
  await gate(orgId, "appointments");
  return unwrap(await A.listAppointments({ orgId, membership, scope: "team", staffEmail: query.staffEmail, from: query.from, to: query.to, status: query.status, contactId: query.contactId }));
});

export const POST = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, email, body }) => {
  await gate(orgId, "appointments");
  const r = unwrap(await A.bookAppointment({ orgId, typeId: body.typeId, staffEmail: body.staffEmail || null, start: body.start, customer: body.customer || {}, customerNote: body.note, answers: body.answers || [], timeZone: body.timeZone, source: "api", actorEmail: email }));
  return { appointment: r.appointment, manageUrl: r.manageUrl };
});
