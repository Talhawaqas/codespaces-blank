// src/lib/support/slaTick.js
//
// SOW §9.5, §27, §53, §61: the SLA scheduler pass. It holds no timers in memory. Each pass, for every ticket
// whose SLA might have crossed a threshold, it RECOMPUTES the SLA from stored values (sla.js) and applies each
// crossed escalation rule through a unique ledger (supportSlaEvents: unique per ticket + target + threshold).
// Consequences:
//   - a worker that was down simply finds every missed threshold on its next pass and applies each exactly
//     once (marked `late`), never twice, no matter how many workers run at once;
//   - notifications are deduplicated by the same key, so a retry cannot spam;
//   - thresholds crossed while a ticket was being solved are recorded too (a late breach is still a breach).
// The same pass auto-closes SOLVED tickets after the configured number of days.

import { toObjectId, getOrgCollections } from "../orgs.js";
import { getSupportCollections } from "./db.js";
import { OPEN_STATUSES, nowIso, RESOLVED_STATUSES } from "./common.js";
import { getSettings } from "./settings.js";
import { calOf, transition, assign } from "./tickets.js";
import { evaluateSla, crossedRules, nextCheckTime } from "./sla.js";
import { escalationTarget } from "./queues.js";
import { audit, emit, link } from "./record.js";
import { notifyStaff } from "./notify.js";

async function recipientsFor(orgId, ticket, rule, team) {
  const out = new Set();
  for (const who of rule.notify || ["assignee"]) {
    if (who === "assignee" && ticket.assigneeEmail) out.add(ticket.assigneeEmail);
    if (who === "team_lead" && team?.leadEmail) out.add(team.leadEmail);
    if (who === "managers") { const { orgMembers } = await getOrgCollections(); (await orgMembers.find({ orgId: toObjectId(orgId), status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { supportRole: "manager" }] }).project({ email: 1 }).toArray()).forEach((m) => out.add(m.email)); }
  }
  return [...out];
}

/** Applies one crossed rule exactly once. Returns true if THIS call applied it. */
async function applyRule({ ticket, settings, rule, late, evaluation }) {
  const { supportSlaEvents, supportTickets, supportTeams } = await getSupportCollections();
  const key = `${ticket._id}:${rule.target}:${rule.pct}`;
  try { await supportSlaEvents.insertOne({ orgId: ticket.orgId, ticketId: ticket._id, key, target: rule.target, pct: rule.pct, action: rule.action, late: !!late, firedAt: nowIso() }); } catch (err) { if (err?.code === 11000) return false; throw err; }
  const orgId = String(ticket.orgId);
  const team = ticket.teamId ? await supportTeams.findOne({ _id: ticket.teamId, orgId: ticket.orgId }) : null;
  const breach = rule.pct >= 100;
  const label = rule.target === "first_response" ? "first response" : "resolution";
  const emails = await recipientsFor(orgId, ticket, rule, team);
  await notifyStaff({ orgId, emails: emails.length ? emails : null, title: breach ? `SLA breached on ${ticket.number} (${label})` : `SLA ${rule.pct}% consumed on ${ticket.number} (${label})`, body: ticket.subject, ticket, dedupeKey: `support:sla:${key}`, severity: breach ? "critical" : "warning", type: "sla" });
  if (breach) await supportTickets.updateOne({ _id: ticket._id }, { $set: { [`sla.breached.${rule.target}`]: true, slaState: "BREACHED" } });
  await audit({ orgId, ticketId: ticket._id, action: breach ? "TICKET_SLA_BREACHED" : "TICKET_SLA_THRESHOLD", actorEmail: "system", metadata: { number: ticket.number, target: rule.target, pct: rule.pct, late: !!late, actual: rule.target === "first_response" ? evaluation.firstPct : evaluation.resolutionPct } });
  await emit({ orgId, type: breach ? "ticket.sla_breached" : "ticket.sla_at_risk", ticket, actor: "system", data: { target: rule.target, pct: rule.pct, late: !!late } });
  link({ orgId, ticketId: ticket._id, type: "CHECKED_BY", targetType: "SUPPORT_SLA_EVENT", targetId: ticket._id, note: `${breach ? "breach" : "threshold"} ${rule.pct}% ${label}${late ? " (recovered late)" : ""}` });
  if (breach && (rule.action === "escalate" || ticket.sla?.breachAction === "escalate") && OPEN_STATUSES.includes(ticket.status) && ticket.status !== "ESCALATED") {
    const tgt = await escalationTarget({ orgId, ticket, policy: { escalationQueueId: ticket.sla?.escalationQueueId ? toObjectId(ticket.sla.escalationQueueId) : null }, queue: null });
    if (tgt.queue || tgt.leadEmail) await assign({ orgId, settings, ticketId: ticket._id, ...(tgt.queue ? { queueId: String(tgt.queue._id) } : {}), ...(tgt.leadEmail ? { assigneeEmail: tgt.leadEmail } : {}), actor: { type: "system", email: "system" } }).catch(() => {});
    await transition({ orgId, settings, ticketId: ticket._id, to: "ESCALATED", actor: { type: "system", email: "system" }, reason: `SLA ${label} breached` }).catch(() => {});
  }
  return true;
}

/** Rules crossed by a COMPLETED target (recorded so a late breach is never lost). */
function completedCrossed(sla) {
  const out = [];
  for (const r of sla.escalations || []) {
    const done = r.target === "first_response" ? !!sla.firstResponseAt : !!sla.resolvedAt;
    if (!done) continue;
    const used = r.target === "first_response" ? sla.accum.firstMin : sla.accum.resolutionMin;
    const target = r.target === "first_response" ? sla.targets.firstResponseMin : sla.targets.resolutionMin;
    if (target > 0 && (used / target) * 100 >= r.pct) out.push(r);
  }
  return out;
}

/** One scheduler pass. Safe to run from any number of workers at once. */
export async function processSlaTick({ now = Date.now(), limit = 300, orgIds = null } = {}) {
  const { supportTickets } = await getSupportCollections();
  const nowStr = new Date(now).toISOString();
  const settingsCache = new Map();
  const settingsFor = async (orgId) => { const k = String(orgId); if (!settingsCache.has(k)) settingsCache.set(k, await getSettings(orgId)); return settingsCache.get(k); };
  const summary = { checked: 0, applied: 0, autoClosed: 0 };
  const scope = orgIds ? { orgId: { $in: orgIds.map((o) => toObjectId(o)) } } : {}; // tests pass the organizations they created; production passes nothing

  const due = await supportTickets.find({ ...scope, status: { $in: OPEN_STATUSES }, sla: { $ne: null }, deletedAt: null, mergedInto: null, $or: [{ slaNextCheckAt: null }, { slaNextCheckAt: { $lte: nowStr } }] }).limit(limit).toArray();
  for (const t of due) {
    const settings = await settingsFor(t.orgId);
    const cal = calOf(t, settings);
    const ev = evaluateSla(t.sla, { cal, settings, now });
    summary.checked++;
    const rules = crossedRules(t.sla, { escalations: t.sla.escalations }, ev);
    for (const r of rules.sort((a, b) => a.pct - b.pct)) {
      // "late" = the threshold was crossed more than 10 minutes of SLA time ago (the scheduler was not looking)
      const pctNow = r.target === "first_response" ? ev.firstPct : ev.resolutionPct;
      const targetMin = r.target === "first_response" ? t.sla.targets.firstResponseMin : t.sla.targets.resolutionMin;
      const lateBy = ((pctNow - r.pct) / 100) * targetMin;
      if (await applyRule({ ticket: t, settings, rule: r, late: lateBy > 10, evaluation: ev })) summary.applied++;
    }
    const nxt = nextCheckTime(t.sla, { escalations: t.sla.escalations }, cal, now);
    await supportTickets.updateOne({ _id: t._id }, { $set: { slaState: ev.state === "BREACHED" || rules.some((r) => r.pct >= 100) ? "BREACHED" : ev.state, slaNextCheckAt: new Date(Math.min(nxt ?? now + 3600000, now + 3600000)).toISOString() } });
  }

  // completed targets: record late breaches once
  const done = await supportTickets.find({ ...scope, sla: { $ne: null }, slaLateChecked: { $ne: true }, $or: [{ "sla.firstResponseAt": { $ne: null } }, { "sla.resolvedAt": { $ne: null } }], deletedAt: null }).limit(limit).toArray();
  for (const t of done) {
    const settings = await settingsFor(t.orgId);
    const ev = evaluateSla(t.sla, { cal: calOf(t, settings), settings, now });
    for (const r of completedCrossed(t.sla)) if (await applyRule({ ticket: t, settings, rule: { ...r, action: "notify" }, late: true, evaluation: ev })) summary.applied++;
    if (t.sla.resolvedAt) await supportTickets.updateOne({ _id: t._id }, { $set: { slaLateChecked: true } });
  }

  // auto-close solved tickets
  const orgsSeen = new Set();
  const solved = await supportTickets.find({ ...scope, status: "SOLVED", deletedAt: null, mergedInto: null, solvedAt: { $ne: null } }).limit(limit).toArray();
  for (const t of solved) {
    const settings = await settingsFor(t.orgId);
    if (now - Date.parse(t.solvedAt) >= settings.autoCloseSolvedAfterDays * 86400000) { const r = await transition({ orgId: String(t.orgId), settings, ticketId: t._id, to: "CLOSED", actor: { type: "system", email: "system" }, reason: "Auto-closed after the solved period" }); if (!r.error) summary.autoClosed++; }
    orgsSeen.add(String(t.orgId));
  }
  return summary;
}
