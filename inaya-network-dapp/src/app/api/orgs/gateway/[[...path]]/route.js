// app/api/orgs/gateway/[[...path]]/route.js -- administration and member views for the Sovereign Gateway (behind FEATURE_SOVEREIGN_GATEWAY). Session + membership.
//
//   GET  mode                                  deployment mode with readiness            POST mode { mode, note?, acknowledgeNoClaim? }   owner/admin
//   GET  gateways                              list                                      GET  gateways/{id}                                 one, with connectors
//   POST enrollments { label }                 one-time enrollment token (shown once)
//   POST gateways/{id}/revoke { reason? }      POST gateways/{id}/commands { type, args? }
//   POST gateways/{id}/connectors              create   PUT gateways/{id}/connectors/{cid}  update   DELETE gateways/{id}/connectors/{cid}
//   GET  gateways/{id}/inventory?connectorId&folderId[&prefix]     administrator listing (audited)
//   GET  gateways/{id}/audit                   forwarded events   GET gateways/{id}/audit/verify    chain check
//   GET  transfers[?gatewayId]   POST transfers { gatewayId, connectorId, folderId, path }   POST transfers/{id}/cancel
//   GET  mappings   POST mappings { principal, email|null }   GET mapping-health   GET permission-changes
//   GET  folders                               folders the CALLER may read          GET folders/{folderId}/browse[?prefix]   enforced by the customer's ACL
//   GET  folders/{folderId}/permissions[?email]   administrator view of the ACL snapshot, diagnostics and one person's effective rights

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireFeature } from "../../../../../lib/featureFlags.js";
import { getClientIp } from "../../../../../lib/rateLimit.js";
import * as G from "../../../../../lib/gateway/gateway.js";
import * as A from "../../../../../lib/gateway/acl.js";
import * as T from "../../../../../lib/gateway/transfers.js";
import * as M from "../../../../../lib/gateway/modes.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const url = new URL(req.url); const q = Object.fromEntries(url.searchParams.entries());
    let body = {}; if (method !== "GET" && method !== "DELETE") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = q.orgId || body.orgId; if (!orgId || typeof orgId !== "string") return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const off = await requireFeature("FEATURE_SOVEREIGN_GATEWAY", orgId); if (off) return json({ error: off.error }, off.status);
    const membership = auth.membership, email = auth.session.email; const base = { orgId, membership, actorEmail: email }; const [a, b, c, d] = path;

    if (a === "mode") return json(method === "POST" ? await M.setMode({ ...base, mode: body.mode, note: body.note, acknowledgeNoClaim: body.acknowledgeNoClaim }) : await M.getProfile({ orgId }));
    if (a === "enrollments" && method === "POST") return json(await G.createEnrollment({ ...base, label: body.label }));
    if (a === "gateways") {
      if (!b) return json(await G.listGateways({ orgId, membership }));
      if (!c && method === "GET") return json(await G.getGateway({ orgId, membership, gatewayId: b }));
      if (c === "revoke" && method === "POST") return json(await G.revokeGateway({ ...base, gatewayId: b, reason: body.reason }));
      if (c === "commands" && method === "POST") return json(await G.queueCommand({ ...base, gatewayId: b, type: body.type, args: body.args }));
      if (c === "connectors") {
        if (method === "POST" && !d) return json(await G.upsertConnector({ ...base, gatewayId: b, name: body.name, type: body.type, rootPath: body.rootPath, folders: body.folders, enabled: body.enabled }), 201);
        if (method === "PUT" && d) return json(await G.upsertConnector({ ...base, gatewayId: b, connectorId: d, name: body.name, type: body.type, rootPath: body.rootPath, folders: body.folders, enabled: body.enabled }));
        if (method === "DELETE" && d) return json(await G.removeConnector({ ...base, gatewayId: b, connectorId: d }));
      }
      if (c === "inventory" && method === "GET") return json(await G.listInventory({ orgId, membership, actorEmail: email, connectorId: q.connectorId, folderId: q.folderId, prefix: q.prefix || "", limit: q.limit }));
      if (c === "audit" && method === "GET") return json(d === "verify" ? await G.verifyGatewayAudit({ orgId, membership, gatewayId: b }) : await G.listGatewayAudit({ orgId, membership, gatewayId: b, limit: q.limit }));
    }
    if (a === "transfers") {
      if (!b && method === "GET") return json(await T.listTransfers({ orgId, membership, gatewayId: q.gatewayId }));
      if (!b && method === "POST") return json(await T.requestTransfer({ ...base, gatewayId: body.gatewayId, connectorId: body.connectorId, folderId: body.folderId, path: body.path, ip: getClientIp(req) }), 201);
      if (b && c === "cancel" && method === "POST") return json(await T.cancelTransfer({ ...base, transferId: b }));
    }
    if (a === "mappings") return json(method === "POST" ? await A.setMapping({ ...base, principal: body.principal, email: body.email }) : await A.listMappings({ orgId, membership }));
    if (a === "mapping-health" && method === "GET") return json(await A.mappingHealth({ orgId, membership }));
    if (a === "permission-changes" && method === "GET") return json(await A.permissionChanges({ orgId, membership, limit: q.limit }));
    if (a === "folders") {
      if (!b && method === "GET") return json(await A.visibleFolders({ orgId, email }));
      if (c === "browse" && method === "GET") return json(await A.browseFolder({ orgId, folderId: b, email, prefix: q.prefix || "", limit: q.limit }));
      if (c === "permissions" && method === "GET") return json(await A.folderPermissions({ orgId, membership, folderId: b, email: q.email || null }));
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof G.GatewayError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("orgs/gateway failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle, POST = handle, PUT = handle, DELETE = handle;
