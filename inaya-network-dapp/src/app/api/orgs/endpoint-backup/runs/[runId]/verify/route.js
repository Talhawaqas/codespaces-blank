// POST { profileId }  compare the run's manifest with what is actually stored
import * as B from "../../../../../../../lib/endpoint/backup.js";
import { route } from "../../../_lib.js";
export const dynamic = "force-dynamic";
export const POST = (req, ctx) => route(req, ctx, ({ orgId, email, membership, body, params }) => B.verifyRun({ orgId, email, membership, profileId: body.profileId, runId: params.runId }));
