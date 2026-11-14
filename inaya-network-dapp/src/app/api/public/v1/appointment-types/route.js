// GET /api/public/v1/appointment-types   active appointment types (duration, location, staff, rules)
import * as A from "../../../../../lib/engagement/appointments.js";
import { publicRoute } from "../_lib.js";
import { unwrap, gate } from "../_engagement.js";
export const dynamic = "force-dynamic";

export const GET = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId }) => { await gate(orgId, "appointments"); return unwrap(await A.listTypes(orgId)); });
