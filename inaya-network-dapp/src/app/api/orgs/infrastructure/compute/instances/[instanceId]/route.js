import { route } from "../../../_lib.js";
import * as O from "../../../../../../../lib/infrastructure/operations.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId, params }) => O.getInstance({ orgId, instanceId: params.instanceId }));
