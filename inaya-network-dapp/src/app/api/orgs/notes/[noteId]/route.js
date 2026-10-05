// app/api/orgs/notes/[noteId]/route.js
//   GET                      one note (metadata, your sealed keys, latest revision)
//   POST { action, ... }     share {targetEmail, perm, keys} | setPermission {targetEmail, perm} | remove {targetEmail, rotation} | rotate {rotation}
//                            | leave | trash | restore
//   DELETE                   permanent delete (owner, from the trash only)
import * as N from "../../../../../lib/notes/notes.js";
import { notesRoute, json } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, params }) => N.getNote({ orgId, email, noteId: params.noteId }));
export const DELETE = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, params }) => N.deleteNotePermanently({ orgId, email, noteId: params.noteId }));
export const POST = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, body, params }) => {
  const a = { orgId, email, noteId: params.noteId };
  switch (body.action) {
    case "share": return N.shareNote({ ...a, targetEmail: body.targetEmail, perm: body.perm, keys: body.keys });
    case "setPermission": return N.setPermission({ ...a, targetEmail: body.targetEmail, perm: body.perm });
    case "remove": return N.rotateNoteKey({ ...a, removeEmail: body.targetEmail, rotation: body.rotation });
    case "rotate": return N.rotateNoteKey({ ...a, rotation: body.rotation });
    case "leave": return N.leaveNote(a);
    case "trash": return N.trashNote(a);
    case "restore": return N.restoreNote(a);
    default: return json({ error: "Unknown action." }, 400);
  }
});
