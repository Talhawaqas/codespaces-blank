import { route } from "../../_lib.js";
import * as I from "../../../../../../lib/infrastructure/nodes.js";

export const GET = (req, ctx) =>
  route(req, ctx, async ({ orgId, params }) => {
    const node = await I.getNode({ orgId, nodeId: params.nodeId });
    return { ...node, health: I.deriveNodeHealth(node) };
  });
