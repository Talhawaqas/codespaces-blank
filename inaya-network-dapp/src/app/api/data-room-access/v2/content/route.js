// GET /api/data-room-access/v2/content?viewId=&part=alpha|beta -> { part, content }  (ciphertext only)
import * as V from "../../../../../lib/dataroom/vdr2.js";
import { visitor } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req) => visitor(req, ({ token, query }) => V.readVisitorContent({ token, viewId: query.viewId, part: query.part }));
