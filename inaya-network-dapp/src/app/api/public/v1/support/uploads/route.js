// POST /api/public/v1/support/uploads  { ticketId, filename, size, sha256? }  (attachments:write) -> { uploadId, chunkBytes, chunks }
import { initHandler } from "../../../../../../lib/support/uploadRoutes.js";
import { resolveApi } from "./_resolve.js";

export const dynamic = "force-dynamic";
export const POST = initHandler(resolveApi);
