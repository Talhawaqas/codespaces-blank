import { route } from "../../../_lib.js";
import * as I from "../../../../../../../lib/infrastructure/nodes.js";

export const POST = (req, ctx) =>
  route(req, ctx, ({ orgId, membership, params }) => I.revokeNode({ orgId, membership, nodeId: params.nodeId }), { requireManage: true });
