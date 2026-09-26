// src/lib/support/analytics.js
//
// SOW §25: support analytics. Every figure is computed from stored tickets, SLA records, CSAT rows and recorded
// events, and each carries the sample size behind it. A metric with no data is reported as null (never 0 or a
// made-up score). Business-hours-aware resolution/response times use the SLA engine's stored clock, not wall time.

import { toObjectId } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { RESOLVED_STATUSES } from "./common.js";
import { evaluateSla, makeCalendar } from "./sla.js";

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

export async function getAnalytics({ orgId, settings, days = 30, now = Date.now() }) {
  const d = Math.min(365, Math.max(1, Math.floor(Number(days) || 30)));
  const since = new Date(now - d * 86400000).toISOString();
  const oid = toObjectId(orgId);
  const { supportTickets, supportCsat, supportEvents, supportKbArticles } = await getSupportCollections();
  const created = await supportTickets.find({ orgId: oid, createdAt: { $gte: since }, deletedAt: null, mergedInto: null }).project({ status: 1, priority: 1, category: 1, channel: 1, queueId: 1, assigneeEmail: 1, sla: 1, slaCalOverride: 1, createdAt: 1, solvedAt: 1, firstResponseAt: 1, reopenCount: 1, aiTriage: 1, type: 1 }).limit(20000).toArray();
  const open = await supportTickets.countDocuments({ orgId: oid, deletedAt: null, mergedInto: null, status: { $nin: RESOLVED_STATUSES } });
  const groupBy = (key) => { const m = {}; for (const t of created) { const k = (typeof key === "function" ? key(t) : t[key]) || "Unassigned"; m[k] = (m[k] || 0) + 1; } return Object.entries(m).map(([k, v]) => ({ key: String(k), count: v })).sort((a, b) => b.count - a.count); };

  const responded = created.filter((t) => t.sla && t.firstResponseAt); const solved = created.filter((t) => t.solvedAt);
  const frMins = []; const resMins = []; let frMet = 0; let frTotal = 0; let resMet = 0; let resTotal = 0; let breached = 0; let slaCount = 0;
  for (const t of created) {
    if (!t.sla) continue; slaCount++;
    const v = evaluateSla(t.sla, { cal: makeCalendar(settings, t.slaCalOverride || null), settings, now });
    if (t.firstResponseAt) { frMins.push(v.timers.firstResponseMin); frTotal++; if (!v.breached.first_response) frMet++; }
    if (t.solvedAt) { resMins.push(v.timers.resolutionMin); resTotal++; if (!v.breached.resolution) resMet++; }
    if (v.breached.first_response || v.breached.resolution) breached++;
  }
  const csat = await supportCsat.find({ orgId: oid, createdAt: { $gte: since } }).project({ score: 1, assigneeEmail: 1 }).toArray();
  const byAgent = {}; for (const t of created) if (t.assigneeEmail) { const a = (byAgent[t.assigneeEmail] ||= { agent: t.assigneeEmail, assigned: 0, solved: 0, resMins: [] }); a.assigned++; if (t.solvedAt) a.solved++; }
  const evCounts = await supportEvents.aggregate([{ $match: { orgId: oid, createdAt: { $gte: since }, type: { $in: ["kb.searched", "chat.answered", "chat.no_answer", "chat.handoff", "kb.viewed"] } } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).toArray();
  const ev = Object.fromEntries(evCounts.map((e) => [e._id, e.n]));
  const zeroResult = await supportEvents.aggregate([{ $match: { orgId: oid, createdAt: { $gte: since }, type: "kb.searched", "data.results": 0 } }, { $group: { _id: "$data.q", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]).toArray();
  const fb = await supportKbArticles.find({ orgId: oid, status: "PUBLISHED" }).project({ title: 1, slug: 1, counters: 1 }).toArray();
  const chatTotal = (ev["chat.answered"] || 0) + (ev["chat.no_answer"] || 0);
  const triaged = created.filter((t) => t.aiTriage?.state === "DONE").length;

  return {
    windowDays: d, since,
    volume: { created: created.length, openNow: open, solved: solved.length, backlogGrowth: created.length - solved.length, reopened: created.filter((t) => t.reopenCount > 0).length, reopenRatePct: pct(created.filter((t) => t.reopenCount > 0).length, solved.length || null) },
    byStatus: groupBy("status"), byPriority: groupBy("priority"), byCategory: groupBy("category"), byChannel: groupBy("channel"), byType: groupBy("type"),
    sla: { withSla: slaCount, firstResponseMet: { met: frMet, of: frTotal, pct: pct(frMet, frTotal) }, resolutionMet: { met: resMet, of: resTotal, pct: pct(resMet, resTotal) }, breachedTickets: breached, breachRatePct: pct(breached, slaCount) },
    times: { firstResponseMinutes: { median: median(frMins), average: avg(frMins), sample: frMins.length }, resolutionMinutes: { median: median(resMins), average: avg(resMins), sample: resMins.length }, basis: "business-hours minutes as measured by each ticket's SLA clock" },
    csat: { responses: csat.length, average: avg(csat.map((c) => c.score)), satisfiedPct: pct(csat.filter((c) => c.score >= 4).length, csat.length), note: csat.length ? null : "No customer ratings in this period." },
    agents: Object.values(byAgent).map((a) => ({ agent: a.agent, assigned: a.assigned, solved: a.solved })).sort((x, y) => y.assigned - x.assigned).slice(0, 25),
    ai: { ticketsTriaged: triaged, ticketsWithTriage: created.length, chat: { answered: ev["chat.answered"] || 0, unanswered: ev["chat.no_answer"] || 0, handedOff: ev["chat.handoff"] || 0, resolvedWithoutTicketPct: pct(Math.max(0, chatTotal - (ev["chat.handoff"] || 0)), chatTotal || null), basis: "chat sessions that ended without a handoff" } },
    knowledge: { searches: ev["kb.searched"] || 0, zeroResultSearches: zeroResult.map((z) => ({ query: z._id, count: z.n })), topArticles: fb.sort((a, b) => (b.counters?.views || 0) - (a.counters?.views || 0)).slice(0, 5).map((a) => ({ title: a.title, slug: a.slug, views: a.counters?.views || 0, helpful: a.counters?.helpful || 0, notHelpful: a.counters?.notHelpful || 0 })) },
  };
}
