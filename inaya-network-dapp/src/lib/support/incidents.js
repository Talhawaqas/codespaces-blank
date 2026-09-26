// src/lib/support/incidents.js
//
// SOW §26: a customer-visible service notice ("we are investigating an outage") that appears on the portal home,
// and an internal incident banner for agents.

import { toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, toPlainText } from "./common.js";
import { audit } from "./record.js";

export const INCIDENT_STATES = ["INVESTIGATING", "IDENTIFIED", "MONITORING", "RESOLVED"];
const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };
const view = (i, forCustomer = false) => ({ id: String(i._id), title: i.title, message: i.message, status: i.status, severity: i.severity, updates: (i.updates || []).map((u) => ({ at: u.at, status: u.status, message: u.message })), startedAt: i.startedAt, resolvedAt: i.resolvedAt || null, customerVisible: !!i.customerVisible, ...(forCustomer ? {} : { createdBy: i.createdBy }) });

export async function createIncident({ orgId, title, message, severity = "minor", customerVisible = true, actor }) {
  await ensureSupportIndexes();
  const t = toPlainText(title, 160); const m = toPlainText(message, 2000);
  if (t.length < 4 || !m) return fail("A title and a message are required.");
  if (!["minor", "major", "critical"].includes(severity)) return fail("severity must be minor, major or critical.");
  const { supportIncidents } = await getSupportCollections();
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), title: t, message: m, severity, status: "INVESTIGATING", customerVisible: !!customerVisible, updates: [{ at: now, status: "INVESTIGATING", message: m }], startedAt: now, updatedAt: now, resolvedAt: null, createdBy: actor.email };
  doc._id = (await supportIncidents.insertOne(doc)).insertedId;
  await audit({ orgId, action: "SUPPORT_INCIDENT_CREATED", actorEmail: actor.email, metadata: { title: t, severity, customerVisible: doc.customerVisible } });
  return { incident: view(doc) };
}

export async function updateIncident({ orgId, incidentId, status, message, actor }) {
  if (!INCIDENT_STATES.includes(status)) return fail(`status must be one of ${INCIDENT_STATES.join(", ")}.`);
  const m = toPlainText(message, 2000); if (!m) return fail("An update message is required.");
  const { supportIncidents } = await getSupportCollections();
  const now = nowIso();
  const r = await supportIncidents.findOneAndUpdate({ _id: oidOf(incidentId) || undefined, orgId: toObjectId(orgId) }, { $set: { status, updatedAt: now, ...(status === "RESOLVED" ? { resolvedAt: now } : {}) }, $push: { updates: { at: now, status, message: m, by: actor.email } } }, { returnDocument: "after" });
  if (!r) return fail("Incident not found.", 404);
  await audit({ orgId, action: "SUPPORT_INCIDENT_UPDATED", actorEmail: actor.email, newState: status, metadata: { title: r.title } });
  return { incident: view(r) };
}

export async function listIncidents({ orgId, activeOnly = false, forCustomer = false }) {
  const { supportIncidents } = await getSupportCollections();
  const f = { orgId: toObjectId(orgId) };
  if (activeOnly) f.status = { $ne: "RESOLVED" };
  if (forCustomer) f.customerVisible = true;
  const rows = await supportIncidents.find(f).sort({ updatedAt: -1 }).limit(forCustomer ? 5 : 50).toArray();
  return { incidents: rows.map((i) => view(i, forCustomer)) };
}
