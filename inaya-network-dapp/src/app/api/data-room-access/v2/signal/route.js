// POST /api/data-room-access/v2/signal { viewId, type } -- viewer signals (download click, print/screenshot-key/blur attempts). Signals, not proof.
import * as V from "../../../../../lib/dataroom/vdr2.js";
import { visitor } from "../_lib.js";
export const dynamic = "force-dynamic";
export const POST = (req) => visitor(req, ({ token, body }) => V.recordViewerSignal({ token, viewId: body.viewId, type: body.type }));
