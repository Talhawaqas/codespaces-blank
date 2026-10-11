import { route } from "../../_lib.js";
import * as I from "../../../../../../lib/infrastructure/nodes.js";

export const GET = (req, ctx) =>
  route(req, ctx, ({ orgId, params }) => I.getCluster({ orgId, clusterId: params.clusterId }));
