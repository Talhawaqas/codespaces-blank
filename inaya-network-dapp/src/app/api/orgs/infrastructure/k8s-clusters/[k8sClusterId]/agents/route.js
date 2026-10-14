import { route } from "../../../_lib.js";
import * as K from "../../../../../../../lib/infrastructure/k8sClusters.js";

export const POST = (req, ctx) =>
  route(
    req,
    ctx,
    ({ orgId, membership, params, body }) =>
      K.addK8sAgent({ orgId, membership, k8sClusterId: params.k8sClusterId, agentVcpu: body.agentVcpu, agentMemoryMib: body.agentMemoryMib, sizeGib: body.sizeGib, nodeId: body.nodeId }),
    { requireManage: true }
  );
