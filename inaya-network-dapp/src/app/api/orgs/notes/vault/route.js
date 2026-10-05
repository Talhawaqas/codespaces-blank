// app/api/orgs/notes/vault/route.js -- the caller's own notes vault (wrapped keys only; the passphrase never reaches the server).
//   GET            -> { vault: {...}|null }
//   POST { vault } -> create (once)
//   PUT  { vault, expectedRev } -> change passphrase (re-wrap only)
import * as N from "../../../../../lib/notes/notes.js";
import { notesRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => notesRoute(req, ctx, async ({ orgId, email }) => ({ vault: await N.getVault({ orgId, email }) }));
export const POST = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, body }) => N.createVault({ orgId, email, vault: body.vault }));
export const PUT = (req, ctx) => notesRoute(req, ctx, ({ orgId, email, body }) => N.rewrapVault({ orgId, email, vault: body.vault, expectedRev: body.expectedRev }));
