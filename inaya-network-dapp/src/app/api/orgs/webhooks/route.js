// GET ?orgId  endpoints + the event catalog    POST { url, events, description, chatMetadata }  create (the signing secret is shown once)
import * as W from "../../../../lib/webhooks/registry.js";
import { route } from "./_lib.js";
export const dynamic = "force-dynamic";
export const GET = (req, ctx) => route(req, ctx, ({ orgId, membership }) => W.listWebhooks({ orgId, membership }));
export const POST = (req, ctx) => route(req, ctx, ({ orgId, membership, email, body }) => W.createWebhook({ orgId, membership, actorEmail: email, url: body.url, events: body.events, description: body.description, chatMetadata: !!body.chatMetadata }));
