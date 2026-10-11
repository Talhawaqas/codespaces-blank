import { route } from "../_lib.js";
import * as I from "../../../../../lib/infrastructure/nodes.js";

export const GET = (req, ctx) =>
  route(req, ctx, ({ orgId }) => I.listClusters({ orgId }).then((clusters) => ({ clusters })));

export const POST = (req, ctx) =>
  route(req, ctx, ({ orgId, membership, body }) => I.createCluster({ orgId, membership, name: body.name, mode: body.mode }), { requireManage: true });
