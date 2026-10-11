import { route } from "../../_lib.js";
import * as O from "../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId, params }) => O.getVolume({ orgId, volumeId: params.volumeId }));

export const DELETE = (req, ctx) =>
  route(req, ctx, ({ orgId, membership, params }) => O.deleteVolume({ orgId, membership, volumeId: params.volumeId }), { requireManage: true });
