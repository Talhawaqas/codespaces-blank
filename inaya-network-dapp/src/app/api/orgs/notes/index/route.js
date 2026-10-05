// app/api/orgs/notes/index/route.js -- the caller's encrypted notes index (pins, favorites, tags, archive, key pins). Compare-and-set.
//   PUT { expectedVersion, iv, ct }
import * as N from "../../../../../lib/notes/notes.js";
import { notesRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const PUT = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, body }) => N.putIndex({ orgId, email, expectedVersion: body.expectedVersion, iv: body.iv, ct: body.ct }));
