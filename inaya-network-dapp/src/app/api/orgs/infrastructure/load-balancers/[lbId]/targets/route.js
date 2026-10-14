import { route } from "../../../_lib.js";
import * as L from "../../../../../../../lib/infrastructure/loadBalancers.js";

export const PATCH = (req, ctx) =>
  route(req, ctx, ({ orgId, membership, params, body }) => L.updateLoadBalancerTargets({ orgId, membership, lbId: params.lbId, targetInstanceIds: body.targetInstanceIds }), { requireManage: true });
