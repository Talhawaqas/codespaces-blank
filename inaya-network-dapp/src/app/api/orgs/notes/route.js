// app/api/orgs/notes/route.js -- Secure Notes (FEATURE_SECURE_NOTES). Ciphertext only.
//   GET  ?orgId[&state=active|trashed&before=]   notes you can open, each with its latest encrypted revision and your sealed keys
//   POST { orgId, noteId, keyEnvelope, revision:{iv,ct} }   create a note (the browser chose the id and encrypted everything)
import * as N from "../../../../lib/notes/notes.js";
import { notesRoute } from "./_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, query }) => N.listNotes({ orgId, email, state: query.state, before: query.before }));
export const POST = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, body }) => N.createNote({ orgId, email, noteId: body.noteId, keyEnvelope: body.keyEnvelope, revision: body.revision }));
