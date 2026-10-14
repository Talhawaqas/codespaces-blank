import { route } from "../_lib.js";
import * as L from "../../../../../lib/infrastructure/loadBalancers.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId, query }) => L.listLoadBalancers({ orgId, clusterId: query.clusterId }).then((loadBalancers) => ({ loadBalancers })));

export const POST = (req, ctx) =>
  route(
    req,
    ctx,
    ({ orgId, membership, body }) =>
      L.createLoadBalancer({
        orgId,
        membership,
        clusterId: body.clusterId,
        nodeId: body.nodeId,
        listenPort: body.listenPort,
        targetInstanceIds: body.targetInstanceIds,
        targetPort: body.targetPort,
        healthCheckIntervalMs: body.healthCheckIntervalMs,
      }),
    { requireManage: true }
  );
