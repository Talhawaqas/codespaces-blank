// SOW §70: smallest safe subset for automation (Terraform, CLI). orgId
// always derives from the API key, per publicRoute()'s own contract.
import { publicRoute } from "../../../_lib.js";
import * as O from "../../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) =>
  publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, query }) => O.listInstances({ orgId, clusterId: query.clusterId }).then((instances) => ({ instances })));

export const POST = (req, ctx) =>
  publicRoute(req, ctx, { flag: "FEATURE_INFRASTRUCTURE" }, ({ orgId, membership, body }) =>
    O.createInstance({ orgId, membership, clusterId: body.clusterId, nodeId: body.nodeId, name: body.name, vcpu: body.vcpu, memoryMib: body.memoryMib, volumeId: body.volumeId, vpcId: body.vpcId })
  );
