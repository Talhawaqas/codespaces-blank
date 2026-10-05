// app/api/orgs/data-rooms/[roomId]/v2/route.js -- Data Room 2.0 management (FEATURE_DATA_ROOM_V2). Staff side, owner/admin (or the room type's own gate).
//   GET  ?orgId[&view=overview|timeline|visitors|questions]     overview = health + settings + documents
//   POST { orgId, action, ... }   settings | addDocuments | updateDocuments | removeDocuments | replaceVersion | saveGroup | invite | answer
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireFeature } from "../../../../../../lib/featureFlags.js";
import * as V from "../../../../../../lib/dataroom/vdr2.js";
import { getDataRoom } from "../../../../../../lib/external-data-room.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function gate(req, ctx, orgIdFrom) {
  const orgId = orgIdFrom; if (!orgId) return { res: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return { res: json({ error: auth.error }, auth.status) };
  const off = await requireFeature("FEATURE_DATA_ROOM_V2", orgId); if (off) return { res: json({ error: off.error }, off.status) };
  return { orgId, auth, params: await ctx.params };
}
const fail = (err) => { if (err instanceof V.VdrError || err?.name === "DlpBlocked") return json({ error: err.message, ...(err.refused ? { refused: err.refused } : {}) }, err.status || 403); console.error("vdr2 route failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500); };

export async function GET(req, ctx) {
  try {
    const q = new URL(req.url).searchParams; const g = await gate(req, ctx, q.get("orgId")); if (g.res) return g.res;
    const a = { orgId: g.orgId, roomId: g.params.roomId, membership: g.auth.membership };
    switch (q.get("view") || "overview") {
      case "timeline": return json(await V.roomTimeline(a));
      case "visitors": return json(await V.listVisitors(a));
      case "questions": return json(await V.listQuestions({ ...a, status: q.get("status") || null }));
      default: {
        const health = await V.roomHealth(a); const room = await getDataRoom(g.orgId, g.params.roomId);
        return json({ health, name: room.name, sections: room.sections || [], settings: room.settings || null, ndaText: room.ndaText || null, groups: room.visitorGroups || [], documents: (room.docSettings || []).map((d) => ({ documentId: String(d.documentId), section: d.section, permission: d.permission, locked: !!d.locked, final: !!d.final })) });
      }
    }
  } catch (err) { return fail(err); }
}
export async function POST(req, ctx) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const g = await gate(req, ctx, body.orgId); if (g.res) return g.res;
    const a = { orgId: g.orgId, roomId: g.params.roomId, membership: g.auth.membership, actorEmail: g.auth.session.email };
    switch (body.action) {
      case "settings": return json(await V.applyRoomSettings({ ...a, settings: body.settings || {} }));
      case "addDocuments": return json(await V.bulkAddDocuments({ ...a, documentIds: body.documentIds, section: body.section, permission: body.permission }));
      case "updateDocuments": return json(await V.updateDocuments({ ...a, documentIds: body.documentIds, patch: body.patch || {} }));
      case "removeDocuments": return json(await V.removeDocuments({ ...a, documentIds: body.documentIds }));
      case "replaceVersion": return json(await V.replaceDocumentVersion({ ...a, oldDocumentId: body.oldDocumentId, newDocumentId: body.newDocumentId }));
      case "saveGroup": return json(await V.saveVisitorGroup({ ...a, name: body.name, emails: body.emails }));
      case "invite": {
        const r = await V.inviteVisitors({ ...a, emails: body.emails, group: body.group, allowedSections: body.allowedSections, role: body.role, expiresInHours: body.expiresInHours, ipAllow: body.ipAllow });
        const origin = new URL(req.url).origin; return json({ invites: r.invites.map((i) => ({ email: i.email, url: `${origin}/room/${i.token}` })) });
      }
      case "answer": return json(await V.answerQuestion({ ...a, questionId: body.questionId, text: body.text }));
      default: return json({ error: "Unknown action." }, 400);
    }
  } catch (err) { return fail(err); }
}
