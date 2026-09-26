// src/lib/support/macros.js
//
// SOW §12.5: agent productivity: canned replies (macros) and saved views. Macros insert TEXT into the reply box
// (rendered with the ticket's own values); they never send anything and never bypass a permission.

import { toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, toPlainText, normEmail, STATUSES } from "./common.js";
import { audit } from "./record.js";

const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

export async function listMacros({ orgId }) {
  const { supportMacros } = await getSupportCollections();
  return { macros: (await supportMacros.find({ orgId: toObjectId(orgId), active: { $ne: false } }).sort({ name: 1 }).toArray()).map((m) => ({ id: String(m._id), name: m.name, body: m.body, setStatus: m.setStatus || null, addTags: m.addTags || [] })) };
}

export async function upsertMacro({ orgId, macroId = null, body, actor }) {
  await ensureSupportIndexes();
  const name = toPlainText(body?.name, 80); const text = toPlainText(body?.body, 4000);
  if (name.length < 2 || !text) return fail("A name and a body are required.");
  if (body?.setStatus && !STATUSES.includes(body.setStatus)) return fail("setStatus is not a known status.");
  const doc = { name, body: text, setStatus: body?.setStatus || null, addTags: (Array.isArray(body?.addTags) ? body.addTags : []).slice(0, 10).map((t) => String(t).slice(0, 30)), active: body?.active !== false, updatedAt: nowIso(), updatedBy: actor.email };
  const { supportMacros } = await getSupportCollections();
  try {
    if (macroId) { const r = await supportMacros.findOneAndUpdate({ _id: oidOf(macroId) || undefined, orgId: toObjectId(orgId) }, { $set: doc }, { returnDocument: "after" }); if (!r) return fail("Macro not found.", 404); return { macro: { id: String(r._id), ...doc } }; }
    const r = await supportMacros.insertOne({ orgId: toObjectId(orgId), ...doc, createdAt: nowIso() });
    await audit({ orgId, action: "SUPPORT_MACRO_CREATED", actorEmail: actor.email, metadata: { name } });
    return { macro: { id: String(r.insertedId), ...doc } };
  } catch (err) { if (err?.code === 11000) return fail("A macro with that name already exists.", 409); throw err; }
}

export async function deleteMacro({ orgId, macroId }) {
  const { supportMacros } = await getSupportCollections();
  const r = await supportMacros.deleteOne({ _id: oidOf(macroId) || undefined, orgId: toObjectId(orgId) });
  return r.deletedCount ? { deleted: true } : fail("Macro not found.", 404);
}

/** Fills {{customer.name}}, {{customer.email}}, {{ticket.number}}, {{ticket.subject}}, {{agent.name}}: nothing else is evaluated. */
export function renderMacro(text, { ticket, agent }) {
  const v = { "customer.name": ticket.requester?.name || "there", "customer.email": ticket.requester?.email || "", "ticket.number": ticket.number, "ticket.subject": ticket.subject, "agent.name": agent?.name || (agent?.email || "").split("@")[0] };
  return String(text).replace(/\{\{\s*([a-z.]+)\s*\}\}/g, (m, k) => (k in v ? v[k] : m));
}

export async function listViews({ orgId, email }) {
  const { supportViews } = await getSupportCollections();
  return { views: (await supportViews.find({ orgId: toObjectId(orgId), $or: [{ ownerEmail: normEmail(email) }, { shared: true }] }).sort({ name: 1 }).toArray()).map((v) => ({ id: String(v._id), name: v.name, filter: v.filter, shared: !!v.shared, mine: v.ownerEmail === normEmail(email) })) };
}
export async function saveView({ orgId, email, body }) {
  const name = toPlainText(body?.name, 60); if (name.length < 2) return fail("A name is required.");
  const f = body?.filter && typeof body.filter === "object" ? Object.fromEntries(["view", "queueId", "status", "assignee", "priority", "q"].filter((k) => body.filter[k]).map((k) => [k, String(body.filter[k]).slice(0, 100)])) : {};
  const { supportViews } = await getSupportCollections();
  const r = await supportViews.insertOne({ orgId: toObjectId(orgId), ownerEmail: normEmail(email), name, filter: f, shared: body?.shared === true, createdAt: nowIso() });
  return { view: { id: String(r.insertedId), name, filter: f, shared: body?.shared === true, mine: true } };
}
export async function deleteView({ orgId, email, viewId }) {
  const { supportViews } = await getSupportCollections();
  const r = await supportViews.deleteOne({ _id: oidOf(viewId) || undefined, orgId: toObjectId(orgId), ownerEmail: normEmail(email) });
  return r.deletedCount ? { deleted: true } : fail("View not found.", 404);
}
