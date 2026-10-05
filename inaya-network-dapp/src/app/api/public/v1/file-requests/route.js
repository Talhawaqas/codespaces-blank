// GET /api/public/v1/file-requests[?status=&limit=&before=]   every file request in the organization (metadata only)
//   Creating a request is NOT offered here: a request has a key pair that must be generated in a browser, because uploads are sealed to it and neither
//   the server nor an API caller may hold the private key. Create requests in the app; list, inspect and revoke them here.
import * as R from "../../../../../lib/filerequests/requests.js";
import { publicRoute } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_ADVANCED_SHARING" }, ({ orgId, membership, email, query }) => R.listRequests({ orgId, actorEmail: email, membership, scope: "org", status: query.status || null, limit: query.limit, before: query.before || null }));
