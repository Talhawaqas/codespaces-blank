import { route } from "../../_lib.js";
import * as O from "../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId, query }) => O.listInstances({ orgId, clusterId: query.clusterId }).then((instances) => ({ instances })));

export const POST = (req, ctx) =>
  route(
    req,
    ctx,
    ({ orgId, membership, body }) =>
      O.createInstance({ orgId, membership, clusterId: body.clusterId, nodeId: body.nodeId, name: body.name, vcpu: body.vcpu, memoryMib: body.memoryMib, volumeId: body.volumeId }),
    { requireManage: true }
  );
