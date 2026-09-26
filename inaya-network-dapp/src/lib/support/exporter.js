// src/lib/support/exporter.js
//
// SOW §27 / §36: export of tickets (agents with export_tickets only). The file carries a SHA-256 integrity hash
// of its own body so recipients can detect alteration; every export is audited. Internal notes are included only
// when the exporter may read them AND asks for them. CSV cells that could be read as spreadsheet formulas are
// neutralized.

import { createHash } from "node:crypto";
import { toObjectId } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { fail, nowIso, normEmail, isEmail } from "./common.js";
import { supportPerms } from "./access.js";
import { audit, emit } from "./record.js";

const MAX = 2000;
const csvCell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export async function exportTickets({ orgId, membership, email, filter = {}, format = "json" }) {
  const perms = supportPerms(membership);
  if (!perms.has("export_tickets")) return fail("You do not have permission to export tickets.", 403);
  if (!["json", "csv"].includes(format)) return fail("format must be json or csv.");
  const { supportTickets, supportMessages } = await getSupportCollections();
  const q = { orgId: toObjectId(orgId), deletedAt: null };
  if (filter.status) q.status = String(filter.status);
  if (filter.since) { if (Number.isNaN(Date.parse(filter.since))) return fail("since must be a date."); q.createdAt = { $gte: new Date(filter.since).toISOString() }; }
  if (filter.requesterEmail) { const e = normEmail(filter.requesterEmail); if (!isEmail(e)) return fail("requesterEmail is invalid."); q["requester.email"] = e; }
  const tickets = await supportTickets.find(q).sort({ createdAt: -1 }).limit(MAX + 1).toArray();
  const truncated = tickets.length > MAX; if (truncated) tickets.length = MAX;
  const includeNotes = perms.has("create_notes") && filter.includeNotes === true;
  let content; let contentType;
  if (format === "csv") {
    const head = ["number", "subject", "status", "priority", "type", "category", "channel", "requester", "assignee", "createdAt", "solvedAt", "slaState"];
    content = [head.join(","), ...tickets.map((t) => [t.number, t.subject, t.status, t.priority, t.type, t.category, t.channel, t.requester?.email, t.assigneeEmail, t.createdAt, t.solvedAt, t.slaState].map(csvCell).join(","))].join("\n");
    contentType = "text/csv; charset=utf-8";
  } else {
    const body = [];
    for (const t of tickets) {
      const msgs = await supportMessages.find({ orgId: t.orgId, ticketId: t._id, ...(includeNotes ? {} : { visibility: "PUBLIC" }) }).sort({ createdAt: 1 }).toArray();
      body.push({ number: t.number, subject: t.subject, status: t.status, priority: t.priority, type: t.type, category: t.category, channel: t.channel, requester: t.requester?.email, assignee: t.assigneeEmail || null, createdAt: t.createdAt, solvedAt: t.solvedAt, closedAt: t.closedAt, slaState: t.slaState, tags: t.tags, messages: msgs.map((m) => ({ at: m.createdAt, visibility: m.visibility, author: m.author?.email, body: m.body })) });
    }
    content = JSON.stringify({ tickets: body }, null, 2);
    contentType = "application/json";
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  await audit({ orgId, action: "TICKETS_EXPORTED", actorEmail: email, metadata: { count: tickets.length, format, includeNotes, truncated, sha256, filter: { status: filter.status || null, since: filter.since || null, requesterEmail: filter.requesterEmail || null } } });
  await emit({ orgId, type: "ticket.exported", data: { count: tickets.length, format, sha256 }, actor: email });
  return { content, contentType, sha256, count: tickets.length, truncated, exportedAt: nowIso(), filename: `tickets-${nowIso().slice(0, 10)}.${format}` };
}
