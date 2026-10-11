import { route } from "../../../../_lib.js";
import * as O from "../../../../../../../../lib/infrastructure/operations.js";

export const POST = (req, ctx) => route(req, ctx, ({ orgId, membership, params }) => O.terminateInstance({ orgId, membership, instanceId: params.instanceId }), { requireManage: true });
