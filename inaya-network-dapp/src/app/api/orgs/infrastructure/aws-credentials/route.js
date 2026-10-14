import { route } from "../_lib.js";
import * as A from "../../../../../lib/infrastructure/awsCredentials.js";

export const GET = (req, ctx) => route(req, ctx, ({ orgId }) => A.listAccessKeys({ orgId }).then((accessKeys) => ({ accessKeys })));

// Mint-only POST -- the secret is returned exactly once in this response,
// same precedent as every other bearer credential this project mints
// (node enrollment tokens, API keys).
export const POST = (req, ctx) => route(req, ctx, ({ orgId, membership }) => A.createAccessKey({ orgId, membership }), { requireManage: true });
