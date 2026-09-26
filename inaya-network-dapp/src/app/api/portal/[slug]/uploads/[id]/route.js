// PUT  /api/portal/:slug/uploads/:id?index=N   raw bytes of chunk N (3 MB each, the last shorter)
// POST /api/portal/:slug/uploads/:id           assemble, scan, store
import { chunkHandlers } from "../../../../../../lib/support/uploadRoutes.js";
import { resolvePortal } from "../_resolve.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const h = chunkHandlers(resolvePortal);
export const PUT = h.PUT;
export const POST = h.POST;
