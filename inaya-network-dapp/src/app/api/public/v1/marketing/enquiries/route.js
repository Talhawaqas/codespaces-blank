// GET /api/public/v1/marketing/enquiries?status   enquiries from booking-page enquiry forms (NEW, CONTACTED, BOOKED, CLOSED)
import * as B from "../../../../../../lib/engagement/booking.js";
import { publicRoute } from "../../_lib.js";
import { unwrap, gate } from "../../_engagement.js";
export const dynamic = "force-dynamic";

export const GET = (req, ctx) => publicRoute(req, ctx, {}, async ({ orgId, membership, query }) => { await gate(orgId, "appointments"); return unwrap(await B.listEnquiries({ orgId, membership, status: query.status })); });
