// PATCH { ...fields, paused? } update, pause or resume    DELETE remove the profile (backed-up files are kept)
import * as B from "../../../../../../lib/endpoint/backup.js";
import { route } from "../../_lib.js";
export const dynamic = "force-dynamic";
export const PATCH = (req, ctx) => route(req, ctx, ({ orgId, email, membership, body, params }) => { const { orgId: _o, ...patch } = body; return B.updateProfile({ orgId, email, membership, profileId: params.profileId, patch }); });
export const DELETE = (req, ctx) => route(req, ctx, ({ orgId, email, membership, params }) => B.deleteProfile({ orgId, email, membership, profileId: params.profileId }));
