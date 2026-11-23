// src/lib/workforce/commissions.js -- Commerce Phase 6 (Master SOW 10.5 sales attribution and commissions; 10.6 checklists).
//   w_comm_rule    a commission rule VERSION: % of net sales (all, or by category / product), effective from a date. Rules are
//                  never edited in place: a change creates a new version, so history is never silently recalculated.
//   w_comm_entry   one commission line per sale (or refund) per attributed person, with the rule version snapshot used
//   w_comm_period  a period (month) summary: DRAFT -> APPROVED by a manager who is not paid in it -> exported
//   w_tip          a tip pool for a branch + day, shared by hours worked (only when the company switches tips on)
//   w_check_tpl    a branch checklist template (opening, closing, cash count, cleaning, receiving, handover ...) with items
//   w_check_run    one completion of a checklist on a date at a branch: item ticks, notes, evidence document ids, sign-off
//   w_incident     an incident report at a branch
// Attribution: a POS sale is attributed to its cashier by default; sale.attribution [{ email, share }] (shares sum to 100)
// lets a manager split it. Commissions are computed from the sale's own net amounts, so they reconcile with sales exactly.
import { getOrgCollections } from "../orgs.js";
import { ccol, oid, sid, clean, fail, nowIso, audit, fromMinor } from "../commerce/store.js";
import { allowedLocation, denyLocation, scopeFilter } from "./scope.js";
import { isMgr } from "./time.js";

export const K = { rule: "w_comm_rule", entry: "w_comm_entry", period: "w_comm_period", tip: "w_tip", tpl: "w_check_tpl", run: "w_check_run", incident: "w_incident" };
let idx = null;
async function ensure() { if (idx) return idx; const c = await ccol(); idx = c.createIndex({ orgId: 1, kind: 1, idem: 1 }, { unique: true, partialFilterExpression: { kind: K.entry }, name: "w_comm_idem" }).catch((e) => { idx = null; throw e; }); return idx; }

// ---------------------------------------------------------------- rules (versioned)
export async function saveRule({ orgId, membership, actorEmail, input = {} }) {
  if (!isMgr(membership)) return fail("Only a manager can set commission rules.", 403);
  const percent = Number(input.percent); if (!(percent >= 0 && percent <= 50)) return fail("Commission is 0-50% of net sales.");
  const from = String(input.effectiveFrom || nowIso().slice(0, 10)); if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return fail("Effective date is YYYY-MM-DD.");
  if (from < nowIso().slice(0, 10)) return fail("A rule can't start in the past (past commissions are never recalculated).", 409);
  const c = await ccol(); const scope = { category: clean(input.category, 60) || null, productId: input.productId ? oid(input.productId) : null, locationId: input.locationId ? oid(input.locationId) : null };
  const prev = await c.findOne({ orgId: oid(orgId), kind: K.rule, ...scope, supersededAt: null }, { sort: { effectiveFrom: -1 } });
  const now = nowIso(); const r = await c.insertOne({ orgId: oid(orgId), kind: K.rule, ...scope, percent, effectiveFrom: from, version: (prev?.version || 0) + 1, supersededAt: null, createdBy: actorEmail, createdAt: now });
  if (prev && prev.effectiveFrom <= from) await c.updateOne({ _id: prev._id }, { $set: { supersededAt: from } });
  await audit({ orgId, actorEmail, recordType: "COMMISSION_RULE", recordId: r.insertedId, action: "COMMISSION_RULE_SAVED", metadata: { percent, from, ...input.category ? { category: input.category } : {} } });
  return { ok: true, id: sid(r.insertedId) };
}
export async function listRules({ orgId }) {
  const c = await ccol(); return { rules: (await c.find({ orgId: oid(orgId), kind: K.rule }).sort({ effectiveFrom: -1 }).toArray()).map((r) => ({ id: sid(r._id), percent: r.percent, category: r.category, productId: sid(r.productId), locationId: sid(r.locationId), effectiveFrom: r.effectiveFrom, supersededAt: r.supersededAt, version: r.version })) };
}
/** Most specific rule in force on the date: product > category > branch > company-wide. */
function pick(rules, line, locationId, day) {
  const live = rules.filter((r) => r.effectiveFrom <= day && (!r.supersededAt || r.supersededAt > day) && (!r.locationId || String(r.locationId) === String(locationId)));
  return live.find((r) => r.productId && String(r.productId) === String(line.productId)) || live.find((r) => r.category && r.category === line.category) || live.find((r) => !r.productId && !r.category && r.locationId) || live.find((r) => !r.productId && !r.category && !r.locationId) || null;
}

// ---------------------------------------------------------------- attribution + accrual
export async function setAttribution({ orgId, membership, actorEmail, saleId, attribution = [], reason }) {
  if (!isMgr(membership)) return fail("Only a manager can change who a sale is credited to.", 403);
  if (String(reason || "").trim().length < 3) return fail("Give a reason for the change.");
  const parts = (Array.isArray(attribution) ? attribution : []).map((a) => ({ email: String(a.email || "").toLowerCase(), share: Number(a.share) })).filter((a) => a.email);
  if (!parts.length || Math.abs(parts.reduce((n, a) => n + a.share, 0) - 100) > 0.01 || parts.some((a) => !(a.share > 0))) return fail("Shares must be positive and add up to 100.");
  const { salesOrders } = await getOrgCollections(); const s = await salesOrders.findOne({ _id: oid(saleId), orgId: oid(orgId), channel: "POS" }); if (!s) return fail("Sale not found.", 404);
  if (!allowedLocation(membership, s.warehouseId)) return denyLocation();
  const c = await ccol(); const p = await c.findOne({ orgId: oid(orgId), kind: K.period, month: String(s.completedAt || s.createdAt).slice(0, 7), status: { $in: ["APPROVED", "EXPORTED"] } });
  if (p) return fail("That month's commissions are already approved; record an adjustment next month instead.", 409);
  await salesOrders.updateOne({ _id: s._id }, { $set: { attribution: parts, attributionChangedBy: actorEmail, attributionReason: clean(reason, 200) } });
  await c.deleteMany({ orgId: oid(orgId), kind: K.entry, saleId: s._id, source: "sale" }); // re-accrue this sale only (its month isn't approved)
  await audit({ orgId, actorEmail, recordType: "SALE", recordId: s._id, action: "SALE_ATTRIBUTION_CHANGED", metadata: { attribution: parts, reason } });
  return accrueSale({ orgId, saleId });
}
/** Commission lines for one sale (idempotent: unique per sale + person + line source). Refunds create negative lines. */
export async function accrueSale({ orgId, saleId }) {
  await ensure(); const { salesOrders, products } = await getOrgCollections(); const c = await ccol();
  const s = await salesOrders.findOne({ _id: oid(saleId), orgId: oid(orgId), channel: "POS" }); if (!s || s.status === "VOIDED") return { entries: 0 };
  const rules = await c.find({ orgId: oid(orgId), kind: K.rule }).toArray(); if (!rules.length) return { entries: 0 };
  const day = String(s.completedAt || s.createdAt).slice(0, 10);
  const people = s.attribution?.length ? s.attribution : s.cashierEmail ? [{ email: s.cashierEmail, share: 100 }] : [];
  const prods = new Map((await products.find({ _id: { $in: (s.lines || []).map((l) => l.productId).filter(Boolean) } }, { projection: { category: 1 } }).toArray()).map((p) => [sid(p._id), p.category || null]));
  let n = 0;
  const write = async (source, lines, sign, refId) => {
    for (const p of people) { let amount = 0; const detail = [];
      for (const [i, l] of lines.entries()) { const r = pick(rules, { productId: l.productId, category: l.category ?? prods.get(sid(l.productId)) }, s.warehouseId, day); if (!r) continue; const net = Math.round((l.netMinor ?? Math.round((l.net ?? 0) * 100)) * p.share / 100); const cm = Math.round(net * r.percent / 100); amount += cm; detail.push({ line: i, netMinor: net, ruleId: r._id, ruleVersion: r.version, percent: r.percent, commissionMinor: cm }); }
      if (!detail.length) continue;
      try { await c.insertOne({ orgId: oid(orgId), kind: K.entry, saleId: s._id, saleNumber: s.saleNumber || null, email: p.email, share: p.share, locationId: s.warehouseId, day, month: day.slice(0, 7), source, amountMinor: sign * amount, detail, idem: `${source}:${sid(s._id)}:${refId || ""}:${p.email}`, createdAt: nowIso() }); n++; } catch (e) { if (e?.code !== 11000) throw e; }
    }
  };
  await write("sale", (s.lines || []).filter((l) => l.productType !== "GIFT_CARD"), 1, null);
  for (const rf of s.refunds || []) { const refLines = (rf.lines || []).map((rl) => { const ol = s.lines?.[rl.lineIndex] || {}; return { productId: ol.productId, category: ol.category, netMinor: rl.netMinor ?? 0 }; }); await write("refund", refLines, -1, rf.refundNumber || rf.idempotencyKey); }
  return { entries: n };
}
export async function accrueRange({ orgId, from, to }) {
  const { salesOrders } = await getOrgCollections(); let n = 0;
  for (const s of await salesOrders.find({ orgId: oid(orgId), channel: "POS", completedAt: { $gte: from, $lte: to } }, { projection: { _id: 1 } }).toArray()) n += (await accrueSale({ orgId, saleId: sid(s._id) })).entries;
  return { entries: n };
}
export async function commissionSummary({ orgId, membership, month }) {
  const m = String(month || nowIso().slice(0, 7)); if (!/^\d{4}-\d{2}$/.test(m)) return fail("Month is YYYY-MM.");
  const mgr = isMgr(membership); const c = await ccol();
  const rows = await c.find({ orgId: oid(orgId), kind: K.entry, month: m, ...(mgr ? scopeFilter(membership, "locationId") : { email: membership.email }) }).toArray();
  const by = new Map(); for (const r of rows) { const x = by.get(r.email) || { email: r.email, sales: 0, refunds: 0, commissionMinor: 0 }; if (r.source === "sale") x.sales++; else x.refunds++; x.commissionMinor += r.amountMinor; by.set(r.email, x); }
  const period = await c.findOne({ orgId: oid(orgId), kind: K.period, month: m });
  return { month: m, status: period?.status || "DRAFT", approvedBy: period?.approvedBy || null, people: [...by.values()].map((x) => ({ ...x, commission: fromMinor(x.commissionMinor) })).sort((a, b) => b.commissionMinor - a.commissionMinor) };
}
/** Approval by a manager who isn't paid any commission that month (no self-approval); after approval the month is locked. */
export async function approvePeriod({ orgId, membership, actorEmail, month }) {
  if (!isMgr(membership)) return fail("Only a manager can approve commissions.", 403);
  const sum = await commissionSummary({ orgId, membership: { role: "admin" }, month }); if (sum.error) return sum;
  if (sum.people.some((p) => p.email === String(actorEmail).toLowerCase())) return fail("You earn commission this month, so someone else must approve it.", 403, "SELF_APPROVAL");
  const c = await ccol(); const r = await c.findOneAndUpdate({ orgId: oid(orgId), kind: K.period, month: sum.month, status: { $nin: ["APPROVED", "EXPORTED"] } }, { $set: { status: "APPROVED", approvedBy: actorEmail, approvedAt: nowIso(), totals: sum.people.map((p) => ({ email: p.email, commissionMinor: p.commissionMinor })) } }, { upsert: true, returnDocument: "after" }).catch((e) => (e?.code === 11000 ? null : Promise.reject(e)));
  if (!r) return fail("Already approved.", 409);
  await audit({ orgId, actorEmail, recordType: "COMMISSION_PERIOD", recordId: r._id, action: "COMMISSIONS_APPROVED", metadata: { month: sum.month, people: sum.people.length } });
  return { ok: true };
}
export async function exportPeriod({ orgId, membership, month }) {
  if (!isMgr(membership)) return fail("Only a manager can export commissions.", 403);
  const c = await ccol(); const p = await c.findOne({ orgId: oid(orgId), kind: K.period, month: String(month) }); if (!p || !["APPROVED", "EXPORTED"].includes(p.status)) return fail("Approve the month first.", 409);
  await c.updateOne({ _id: p._id }, { $set: { status: "EXPORTED", exportedAt: nowIso() } });
  return { csv: ["email,month,commission", ...p.totals.map((t) => `${t.email},${p.month},${fromMinor(t.commissionMinor).toFixed(2)}`)].join("\n") + "\n" };
}
/** Tips (only when switched on): a branch-day pool shared by hours each person actually worked that day. */
export async function allocateTips({ orgId, membership, actorEmail, locationId, date, amount }) {
  if (!isMgr(membership)) return fail("Only a manager can allocate tips.", 403); if (!allowedLocation(membership, locationId)) return denyLocation();
  const total = Math.round(Number(amount) * 100); if (!(total > 0)) return fail("Enter the tip total.");
  const { timesheet } = await import("./time.js"); const c = await ccol();
  const emails = await c.distinct("email", { orgId: oid(orgId), kind: "w_punch", locationId: oid(locationId), at: { $gte: `${date}T00:00:00.000Z`, $lte: `${date}T23:59:59.999Z` } });
  const hours = []; for (const e of emails) { const t = await timesheet({ orgId, membership: { role: "admin" }, email: e, from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }); hours.push({ email: e, hours: t.totalHours }); }
  const sumH = hours.reduce((n, h) => n + h.hours, 0); if (!(sumH > 0)) return fail("Nobody has recorded hours at that branch on that day.", 409);
  let given = 0; const alloc = hours.map((h, i) => { const share = i === hours.length - 1 ? total - given : Math.floor(total * h.hours / sumH); given += share; return { email: h.email, hours: h.hours, amountMinor: share }; });
  const r = await c.insertOne({ orgId: oid(orgId), kind: K.tip, locationId: oid(locationId), date, totalMinor: total, allocation: alloc, by: actorEmail, createdAt: nowIso() });
  await audit({ orgId, actorEmail, recordType: "TIPS", recordId: r.insertedId, action: "TIPS_ALLOCATED", metadata: { date, total: fromMinor(total) } });
  return { allocation: alloc.map((a) => ({ ...a, amount: fromMinor(a.amountMinor) })) };
}

// ---------------------------------------------------------------- checklists, handovers and incidents
export const CHECK_TYPES = ["OPENING", "CLOSING", "CASH_COUNT", "CLEANING_SAFETY", "STOCK_RECEIVING", "TEMPERATURE_MAINTENANCE", "HANDOVER", "CUSTOM"];
export async function saveChecklist({ orgId, membership, actorEmail, input = {} }) {
  if (!isMgr(membership)) return fail("Only a manager can edit checklists.", 403);
  if (!CHECK_TYPES.includes(input.type)) return fail("Choose the checklist type.");
  const items = (Array.isArray(input.items) ? input.items : []).map((x) => clean(typeof x === "string" ? x : x.text, 200)).filter(Boolean).slice(0, 60); if (!items.length) return fail("Add at least one item.");
  const loc = input.locationId ? oid(input.locationId) : null; if (loc && !allowedLocation(membership, loc)) return denyLocation();
  const c = await ccol(); const doc = { name: clean(input.name, 80) || input.type, type: input.type, items, locationId: loc, dueTime: /^\d{2}:\d{2}$/.test(input.dueTime || "") ? input.dueTime : null, recurrence: ["DAILY", "WEEKDAYS", "WEEKLY", "NONE"].includes(input.recurrence) ? input.recurrence : "DAILY", evidenceRequired: !!input.evidenceRequired, active: input.active !== false, updatedAt: nowIso() };
  if (input.id) await c.updateOne({ _id: oid(input.id), orgId: oid(orgId), kind: K.tpl }, { $set: doc }); else await c.insertOne({ orgId: oid(orgId), kind: K.tpl, ...doc, createdBy: actorEmail, createdAt: nowIso() });
  await audit({ orgId, actorEmail, recordType: "CHECKLIST", recordId: oid(orgId), action: "CHECKLIST_SAVED", metadata: { name: doc.name, type: doc.type } });
  return { ok: true };
}
const due = (t, day) => t.recurrence === "DAILY" || (t.recurrence === "WEEKDAYS" && ![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())) || (t.recurrence === "WEEKLY" && new Date(`${day}T12:00:00Z`).getUTCDay() === 1);
/** Today's checklists for a branch: which are due, done, overdue (past their due time and not signed off). */
export async function branchChecklists({ orgId, membership, locationId, date, now = new Date() }) {
  if (!allowedLocation(membership, locationId)) return denyLocation();
  const day = String(date || now.toISOString().slice(0, 10)); const c = await ccol();
  const tpls = (await c.find({ orgId: oid(orgId), kind: K.tpl, active: true, $or: [{ locationId: null }, { locationId: oid(locationId) }] }).toArray()).filter((t) => due(t, day));
  const runs = new Map((await c.find({ orgId: oid(orgId), kind: K.run, locationId: oid(locationId), date: day }).toArray()).map((r) => [sid(r.templateId), r]));
  return { date: day, checklists: tpls.map((t) => { const r = runs.get(sid(t._id)); const overdue = !r?.signedOffAt && t.dueTime && now.toISOString() > `${day}T${t.dueTime}:00.000Z`; return { templateId: sid(t._id), name: t.name, type: t.type, items: t.items, dueTime: t.dueTime, evidenceRequired: t.evidenceRequired, runId: sid(r?._id), done: (r?.ticks || []).filter(Boolean).length, total: t.items.length, signedOffBy: r?.signedOffBy || null, signedOffAt: r?.signedOffAt || null, state: r?.signedOffAt ? "DONE" : overdue ? "OVERDUE" : r ? "IN_PROGRESS" : "DUE" }; }) };
}
export async function tickChecklist({ orgId, membership, actorEmail, templateId, locationId, date, ticks = [], notes = [], evidence = [], signOff = false }) {
  if (!allowedLocation(membership, locationId)) return denyLocation();
  const c = await ccol(); const t = await c.findOne({ _id: oid(templateId), orgId: oid(orgId), kind: K.tpl }); if (!t) return fail("Checklist not found.", 404);
  const day = String(date || nowIso().slice(0, 10));
  const run = await c.findOne({ orgId: oid(orgId), kind: K.run, templateId: t._id, locationId: oid(locationId), date: day });
  if (run?.signedOffAt) return fail("This checklist is already signed off.", 409);
  const tk = t.items.map((_, i) => !!ticks[i]); const nt = t.items.map((_, i) => clean(notes[i], 300) || null); const ev = (Array.isArray(evidence) ? evidence : []).map(String).filter((x) => /^[a-f0-9]{24}$/.test(x)).slice(0, 20);
  if (signOff) { if (tk.some((x) => !x)) return fail("Tick every item (or add a note why) before signing off.", 409); if (t.evidenceRequired && !ev.length && !run?.evidence?.length) return fail("Attach evidence (a photo or document) before signing off.", 409); }
  const set = { ticks: tk, notes: nt, evidence: ev.length ? ev : run?.evidence || [], updatedBy: actorEmail, updatedAt: nowIso(), ...(signOff ? { signedOffBy: actorEmail, signedOffAt: nowIso() } : {}) };
  await c.updateOne({ orgId: oid(orgId), kind: K.run, templateId: t._id, locationId: oid(locationId), date: day }, { $set: set, $setOnInsert: { name: t.name, type: t.type, createdAt: nowIso() } }, { upsert: true });
  if (signOff) await audit({ orgId, actorEmail, recordType: "CHECKLIST", recordId: t._id, action: "CHECKLIST_SIGNED_OFF", metadata: { name: t.name, date: day, locationId: String(locationId) } });
  return { ok: true };
}
export async function reportIncident({ orgId, membership, actorEmail, input = {} }) {
  if (!allowedLocation(membership, input.locationId)) return denyLocation();
  const summary = clean(input.summary, 200); if (summary.length < 5) return fail("Describe what happened.");
  const sev = ["LOW", "MEDIUM", "HIGH"].includes(input.severity) ? input.severity : "LOW";
  const c = await ccol(); const r = await c.insertOne({ orgId: oid(orgId), kind: K.incident, locationId: oid(input.locationId), summary, details: clean(input.details, 3000), severity: sev, status: "OPEN", evidence: (input.evidence || []).map(String).slice(0, 20), reportedBy: actorEmail, at: nowIso(), createdAt: nowIso() });
  await audit({ orgId, actorEmail, recordType: "INCIDENT", recordId: r.insertedId, action: "INCIDENT_REPORTED", metadata: { severity: sev } });
  return { id: sid(r.insertedId) };
}
export async function listIncidents({ orgId, membership, status = null }) {
  const c = await ccol(); return { incidents: (await c.find({ orgId: oid(orgId), kind: K.incident, ...(status ? { status } : {}), ...scopeFilter(membership, "locationId") }).sort({ at: -1 }).limit(200).toArray()).map((x) => ({ id: sid(x._id), locationId: sid(x.locationId), summary: x.summary, severity: x.severity, status: x.status, reportedBy: x.reportedBy, at: x.at, resolvedBy: x.resolvedBy || null })) };
}
export async function resolveIncident({ orgId, membership, actorEmail, id, resolution }) {
  if (!isMgr(membership)) return fail("Only a manager can close incidents.", 403); const c = await ccol(); const x = await c.findOne({ _id: oid(id), orgId: oid(orgId), kind: K.incident }); if (!x) return fail("Incident not found.", 404); if (!allowedLocation(membership, x.locationId)) return denyLocation();
  if (String(resolution || "").trim().length < 5) return fail("Describe how it was resolved.");
  await c.updateOne({ _id: x._id }, { $set: { status: "RESOLVED", resolution: clean(resolution, 1000), resolvedBy: actorEmail, resolvedAt: nowIso() } }); return { ok: true };
}
