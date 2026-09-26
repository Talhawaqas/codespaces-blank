// POST /api/portal/:slug/uploads  { ticketId | ideaId, filename, size, sha256? } -> { uploadId, chunkBytes, chunks }
import { initHandler } from "../../../../../lib/support/uploadRoutes.js";
import { resolvePortal } from "./_resolve.js";

export const dynamic = "force-dynamic";
export const POST = initHandler(resolvePortal);
