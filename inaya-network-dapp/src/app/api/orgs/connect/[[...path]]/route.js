// app/api/orgs/connect/[[...path]]/route.js -- Inaya Connect company API (session + membership first; entitlement and
// role checks live in src/lib/connect/*). Secrets are accepted here and stored encrypted; they are never returned.
//   GET  me | connection | settings | conversations?status&mode&mine&q | conversations/{id} | documents?status
//   GET  documents/{id}/file | usage | events?type | links
//   POST connection {phoneNumberId, wabaId, accessToken, appSecret} | connection/rotate-verify-token
//   POST connection/credentials {accessToken?, appSecret?} | connection/disconnect {reason} | connection/test {to}
//   POST settings | conversations/{id}/reply {text} | conversations/{id}/{takeover|resume_ai|assign|close|reopen|note|ticket}
//   POST documents/{id} {action: bookkeeper|filed|reject, note} | links (create my link code) | links/remove {email}
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg } from "../../../../../lib/orgs.js";
import { slidingWindowCheck } from "../../../../../lib/rateLimit.js";
import * as C from "../../../../../lib/connect/core.js";
import * as N from "../../../../../lib/connect/connection.js";
import * as I from "../../../../../lib/connect/inbox.js";
import * as P from "../../../../../lib/connect/process.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, r.status || 400) : json(r));
async function ctx(req, orgId) {
  if (!orgId || !/^[0-9a-f]{24}$/i.test(orgId)) return { error: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes(); await C.ensureConnectIndexes(); const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: json({ error: auth.error }, auth.status) };
  return { membership: { ...auth.membership, email: auth.session.email }, actorEmail: auth.session.email };
}
async function limited(key, max, windowMs) { try { const r = await slidingWindowCheck({ action: "inaya-connect", key, max, windowMs }); return r?.allowed === false || r?.limited === true; } catch { return false; } }

export async function GET(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const qs = new URL(req.url).searchParams; const q = (k) => qs.get(k) || undefined; const orgId = qs.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    const b = { orgId, membership: c.membership };
    if (path === "me") { const entitled = await C.connectEntitled(orgId); return json({ entitled, email: c.actorEmail, admin: canManageOrg(c.membership), agent: canManageOrg(c.membership) || ["agent", "manager"].includes(c.membership.supportRole), webhookUrl: N.webhookUrl(), connected: entitled ? (await N.getConnection(orgId))?.status || null : null }); }
    if (path === "connection") return out(await N.connectionStatus(b));
    if (path === "settings") { const d = await C.connectAccess({ ...b, need: "agent" }); if (d) return out(d); return json({ settings: await C.getSettings(orgId) }); }
    if (path === "conversations") return out(await I.listConversations({ ...b, status: q("status"), mode: q("mode"), mine: q("mine") === "1", q: q("q") }));
    if (seg[0] === "conversations" && seg[1] && !seg[2]) return out(await I.getConversation({ ...b, convId: seg[1] }));
    if (path === "documents") return out(await I.listDocuments({ ...b, status: q("status") }));
    if (seg[0] === "documents" && seg[2] === "file") {
      const f = await I.documentFile({ ...b, docId: seg[1] }); if (f.error) return out(f);
      const inline = /^(image\/|application\/pdf)/.test(f.mime || "");
      return new NextResponse(f.buffer, { headers: { "Content-Type": f.mime || "application/octet-stream", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${String(f.filename || "file").replace(/["\r\n]/g, "")}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" } });
    }
    if (path === "usage") return out(await I.usage(b));
    if (path === "events") return out(await I.events({ ...b, type: q("type") }));
    if (path === "links") { const d = await C.connectAccess({ ...b, need: "admin" }); if (d) return out(d); return json({ links: await P.listLinks({ orgId }) }); }
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("connect GET failed:", e?.message); return json({ error: "Something went wrong." }, 500); }
}

export async function POST(req, { params }) {
  params = await params; const seg = params.path || []; const path = seg.join("/");
  try {
    const orgId = new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error;
    if (await limited(`${orgId}:${c.actorEmail}`, 120, 60000)) return json({ error: "Too many requests. Wait a minute." }, 429);
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const b = { orgId, membership: c.membership, actorEmail: c.actorEmail };
    if (path === "connection") { if (await limited(`connect:${orgId}`, 10, 3600000)) return json({ error: "Too many connection attempts. Try again later." }, 429); return out(await N.connect({ ...b, input: body })); }
    if (path === "connection/link-app") return out(await N.relinkApp(b));
    if (path === "connection/rotate-verify-token") return out(await N.rotateVerifyToken(b));
    if (path === "connection/credentials") return out(await N.updateToken({ ...b, accessToken: body.accessToken, appSecret: body.appSecret }));
    if (path === "connection/disconnect") return out(await N.disconnect({ ...b, reason: body.reason }));
    if (path === "connection/test") { if (await limited(`test:${orgId}`, 10, 3600000)) return json({ error: "Too many test messages. Try again later." }, 429); return out(await N.testMessage({ ...b, to: body.to })); }
    if (path === "settings") return out(await C.saveSettings({ ...b, input: body }));
    if (seg[0] === "conversations" && seg[2] === "reply") return out(await I.reply({ ...b, convId: seg[1], text: body.text }));
    if (seg[0] === "conversations" && seg[2]) return out(await I.setMode({ ...b, convId: seg[1], action: seg[2], assignee: body.assignee, note: body.note }));
    if (seg[0] === "documents" && seg[1] && !seg[2]) return out(await I.decideDocument({ ...b, docId: seg[1], action: body.action, note: body.note }));
    if (path === "links") { const d = await C.connectAccess({ ...b, need: "member" }); if (d) return out(d); return out(await P.createLinkCode({ orgId, membership: c.membership, email: c.actorEmail })); }
    if (path === "links/remove") { const email = String(body.email || "").toLowerCase(); const d = await C.connectAccess({ ...b, need: email === c.actorEmail ? "member" : "admin" }); if (d) return out(d); return out(await P.unlink({ orgId, email, actorEmail: c.actorEmail })); }
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("connect POST failed:", e?.message); return json({ error: "Something went wrong." }, 500); }
}
