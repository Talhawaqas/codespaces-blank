import { chunkHandlers } from "../../../../../../../lib/support/uploadRoutes.js";
import { resolveApi } from "../_resolve.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
const h = chunkHandlers(resolveApi);
export const PUT = h.PUT;
export const POST = h.POST;
