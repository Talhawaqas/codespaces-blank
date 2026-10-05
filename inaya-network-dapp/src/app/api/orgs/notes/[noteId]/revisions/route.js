// app/api/orgs/notes/[noteId]/revisions/route.js
//   GET ?orgId[&rev=N | &before=N]   a revision's ciphertext, or the version list (who/when, never content)
//   POST { baseRev, keyVersion, iv, ct }   save a new revision; 409 CONFLICT (with the newer revision) if baseRev is stale
import * as N from "../../../../../../lib/notes/notes.js";
import { notesRoute } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, query, params }) => (query.rev ? N.getRevision({ orgId, email, noteId: params.noteId, rev: query.rev }) : N.listRevisions({ orgId, email, noteId: params.noteId, before: query.before })));
export const POST = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, body, params }) => N.saveRevision({ orgId, email, noteId: params.noteId, baseRev: body.baseRev, keyVersion: body.keyVersion, iv: body.iv, ct: body.ct }));
