// GET ?webhookId&status=PENDING|DELIVERED|DEAD   delivery history and the dead-letter list      POST { deliveryId }  redeliver a failed or dead-lettered delivery
import * as W from "../../../../../lib/webhooks/registry.js";
import { route } from "../_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, membership, query }) => W.listDeliveries({ orgId, membership, webhookId: query.webhookId || null, status: query.status || null, limit: query.limit }));
export const POST = (req, ctx) => route(req, ctx, ({ orgId, membership, email, body }) => W.redeliver({ orgId, membership, actorEmail: email, deliveryId: body.deliveryId }));
