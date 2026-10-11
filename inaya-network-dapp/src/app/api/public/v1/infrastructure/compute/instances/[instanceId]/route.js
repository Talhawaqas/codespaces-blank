import { publicRoute } from "../../../../_lib.js";
import * as O from "../../../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, params }) => O.getInstance({ orgId, instanceId: params.instanceId }));

// Terraform's Delete maps to a real terminate operation -- there is no
// synchronous delete; the resource becomes TERMINATED once the node
// daemon's next poll cycle executes it.
export const DELETE = (req, ctx) => publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, membership, params }) => O.terminateInstance({ orgId, membership, instanceId: params.instanceId }));
