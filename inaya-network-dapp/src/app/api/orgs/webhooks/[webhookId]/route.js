// PATCH { url?, events?, description? }   POST { action: pause | resume | rotate | test }   DELETE
import * as W from "../../../../../lib/webhooks/registry.js";
import { route, json } from "../_lib.js";
export const dynamic = "force-dynamic";
export const PATCH = (req, ctx) => route(req, ctx, ({ orgId, membership, email, body, params }) => W.updateWebhook({ orgId, membership, actorEmail: email, webhookId: params.webhookId, url: body.url, events: body.events, description: body.description }));
export const DELETE = (req, ctx) => route(req, ctx, ({ orgId, membership, email, params }) => W.deleteWebhook({ orgId, membership, actorEmail: email, webhookId: params.webhookId }));
export const POST = (req, ctx) => route(req, ctx, ({ orgId, membership, email, body, params }) => {
  const a = { orgId, membership, actorEmail: email, webhookId: params.webhookId };
  switch (body.action) { case "pause": return W.setPaused({ ...a, paused: true }); case "resume": return W.setPaused({ ...a, paused: false }); case "rotate": return W.rotateSecret(a); case "test": return W.sendTest(a); default: return json({ error: "Unknown action." }, 400); }
});
