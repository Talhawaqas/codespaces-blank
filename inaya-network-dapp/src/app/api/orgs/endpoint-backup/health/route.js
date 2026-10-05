// GET -> backup health across the organization (owner/admin)
import * as B from "../../../../../lib/endpoint/backup.js";
import { route } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, membership }) => B.healthOverview({ orgId, membership }));
