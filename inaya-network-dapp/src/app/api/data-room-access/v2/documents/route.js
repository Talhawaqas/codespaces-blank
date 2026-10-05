// GET /api/data-room-access/v2/documents -- the documents this visitor may see (names, sizes, sections, what they may do). No storage pointers.
import * as V from "../../../../../lib/dataroom/vdr2.js";
import { visitor } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req) => visitor(req, ({ token, ip }) => V.listVisitorDocuments({ token, ip }));
