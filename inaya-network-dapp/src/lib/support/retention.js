// src/lib/support/retention.js
//
// SOW §40: retention. Per-organization windows (settings.retention). What this does, precisely:
//   - AI chat transcripts older than chatDays are deleted (customers are told they are short-lived), unless the
//     conversation was handed off to a ticket;
//   - closed tickets older than ticketDays get an `archivedAt` marker; tickets on legal hold (`legalHold: true`)
//     are never touched;
//   - the audit chain is never edited or deleted by this module (append-only by design).
// It runs at most once an hour (a lock document), from the cron worker.

import { toObjectId } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { getSettings } from "./settings.js";
import { audit } from "./record.js";

async function takeLock(supportCounters, now) {
  // claim "the hour": succeeds for exactly one worker per hour
  const r = await supportCounters.findOneAndUpdate({ _id: "retention:last", at: { $lte: now - 3600000 } }, { $set: { at: now } });
  if (r) return true;
  try { await supportCounters.insertOne({ _id: "retention:last", at: now }); return true; } catch { return false; }
}

export async function runRetention({ now = Date.now(), force = false, orgIds = null } = {}) {
  const { supportSettings, supportChatSessions, supportTickets, supportCounters } = await getSupportCollections();
  if (!force && !(await takeLock(supportCounters, now))) return { skipped: true };
  const out = { orgs: 0, chatsDeleted: 0, ticketsArchived: 0 };
  const orgs = await supportSettings.find(orgIds ? { orgId: { $in: orgIds.map((o) => toObjectId(o)) } } : {}).project({ orgId: 1 }).limit(500).toArray();
  for (const o of orgs) {
    const s = await getSettings(o.orgId);
    out.orgs++;
    const chatCut = new Date(now - s.retention.chatDays * 86400000).toISOString();
    const c = await supportChatSessions.deleteMany({ orgId: o.orgId, updatedAt: { $lt: chatCut }, handedOffTicketId: null });
    out.chatsDeleted += c.deletedCount;
    const tCut = new Date(now - s.retention.ticketDays * 86400000).toISOString();
    const r = await supportTickets.updateMany({ orgId: o.orgId, status: "CLOSED", closedAt: { $lt: tCut }, archivedAt: { $exists: false }, legalHold: { $ne: true }, deletedAt: null }, { $set: { archivedAt: new Date(now).toISOString() } });
    out.ticketsArchived += r.modifiedCount;
    if (c.deletedCount || r.modifiedCount) await audit({ orgId: o.orgId, action: "SUPPORT_RETENTION_RUN", metadata: { chatsDeleted: c.deletedCount, ticketsArchived: r.modifiedCount } });
  }
  return out;
}
