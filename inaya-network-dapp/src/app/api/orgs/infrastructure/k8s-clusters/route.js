import { route } from "../_lib.js";
import * as K from "../../../../../lib/infrastructure/k8sClusters.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId, query }) => K.listK8sClusters({ orgId, clusterId: query.clusterId }).then((k8sClusters) => ({ k8sClusters })));

export const POST = (req, ctx) =>
  route(
    req,
    ctx,
    ({ orgId, membership, body }) =>
      K.createK8sCluster({
        orgId,
        membership,
        clusterId: body.clusterId,
        nodeId: body.nodeId,
        vpcId: body.vpcId,
        serverVcpu: body.serverVcpu,
        serverMemoryMib: body.serverMemoryMib,
        sizeGib: body.sizeGib,
      }),
    { requireManage: true }
  );
