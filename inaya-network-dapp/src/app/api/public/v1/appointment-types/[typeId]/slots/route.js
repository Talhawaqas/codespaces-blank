// GET /api/public/v1/appointment-types/{typeId}/slots?from&to&staffEmail   free start times (ISO, UTC) with the staff who can take each
import * as A from "../../../../../../../lib/engagement/appointments.js";
import { publicRoute } from "../../../_lib.js";
import { unwrap, gate } from "../../../_engagement.js";
export const dynamic = "force-dynamic";

export const GET = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, query, params }) => {
  await gate(orgId, "appointments");
  const type = await A.getType(orgId, params.typeId);
  if (!type) unwrap({ error: "Appointment type not found.", status: 404 });
  return unwrap(await A.availableSlots({ orgId, type, from: query.from, to: query.to, staffEmail: query.staffEmail || null }));
});
