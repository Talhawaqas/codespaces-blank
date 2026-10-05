// app/api/orgs/notes/people/route.js -- members who can receive a shared note (they have a vault), with their public keys.
import * as N from "../../../../../lib/notes/notes.js";
import { notesRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => notesRoute(req, ctx, ({ orgId, email }) => N.listPeople({ orgId, email }));
