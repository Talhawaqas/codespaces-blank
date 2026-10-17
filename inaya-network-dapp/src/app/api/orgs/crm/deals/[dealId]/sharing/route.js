// /api/orgs/crm/deals/:dealId/sharing — see lib/record-sharing-route.js.
import { makeSharingHandlers } from "../../../../../../../lib/record-sharing-route.js";

const handlers = makeSharingHandlers({ recordType: "DEAL", idParam: "dealId" });
export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
