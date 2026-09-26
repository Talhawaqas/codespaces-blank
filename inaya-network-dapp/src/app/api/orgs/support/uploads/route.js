// POST /api/orgs/support/uploads?orgId=  { ticketId, internal?, messageId?, filename, size, sha256? }
import { initHandler } from "../../../../../lib/support/uploadRoutes.js";
import { resolveAgent } from "./_resolve.js";

export const dynamic = "force-dynamic";
export const POST = initHandler(resolveAgent);
