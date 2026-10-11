import { route } from "../_lib.js";
import * as I from "../../../../../lib/infrastructure/nodes.js";

export const GET = (req, ctx) =>
  route(req, ctx, ({ orgId, query }) =>
    I.listNodes({ orgId, clusterId: query.clusterId }).then((nodes) => ({
      nodes: nodes.map((n) => ({ ...n, health: I.deriveNodeHealth(n) })),
    }))
  );
