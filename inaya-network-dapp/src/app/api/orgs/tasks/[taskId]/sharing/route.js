// /api/orgs/tasks/:taskId/sharing — see lib/record-sharing-route.js.
import { makeSharingHandlers } from "../../../../../../lib/record-sharing-route.js";

const handlers = makeSharingHandlers({ recordType: "TASK", idParam: "taskId" });
export const GET = handlers.GET;
export const PATCH = handlers.PATCH;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
