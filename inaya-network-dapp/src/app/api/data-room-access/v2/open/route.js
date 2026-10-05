// POST /api/data-room-access/v2/open { documentId, deviceId? } -> { viewId, filename, mode, watermark, expiresAt, parts }
import * as V from "../../../../../lib/dataroom/vdr2.js";
import { visitor } from "../_lib.js";
export const dynamic = "force-dynamic";
export const POST = (req) => visitor(req, ({ token, body, ip }) => V.openVisitorDocument({ token, documentId: body.documentId, ip, deviceId: body.deviceId }));
