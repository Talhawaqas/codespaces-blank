// src/lib/salesLeads.js
//
// Inaya's own prospect list for Business Workspace outreach (not a customer
// org's CRM). Leads are grouped into regional batches; the outreach sender
// (Downloads/erp-outreach) moves them NEW -> EMAILED -> FOLLOWED_UP, and the
// admin page (/admin/leads) records what happened next.

import { ObjectId } from "mongodb";
import { connectToDatabase } from "./mongodb.js";

export const LEAD_BATCHES = ["PK", "UK", "US", "EU"];
export const LEAD_STATUSES = ["NEW", "EMAILED", "FOLLOWED_UP", "REPLIED", "INTERESTED", "PILOT", "NOT_INTERESTED", "UNSUBSCRIBED", "BOUNCED"];
const EDITABLE = ["company", "sector", "city", "country", "website", "contactName", "contactRole", "email", "phone", "source", "fitNote", "notes"];

let indexed = false;
async function leads() {
  const { db } = await connectToDatabase();
  const col = db.collection("sales_leads");
  if (!indexed) {
    await col.createIndex({ email: 1 }, { unique: true });
    await col.createIndex({ batch: 1, status: 1 });
    indexed = true;
  }
  return col;
}

function clean(input) {
  const out = {};
  for (const k of EDITABLE) if (input[k] !== undefined) out[k] = String(input[k] ?? "").trim().slice(0, k === "notes" || k === "fitNote" ? 2000 : 200);
  if (out.email !== undefined) out.email = out.email.toLowerCase();
  return out;
}

export function serializeLead(l) {
  return { id: String(l._id), batch: l.batch, status: l.status, ...Object.fromEntries(EDITABLE.map((k) => [k, l[k] ?? ""])), emailedAt: l.emailedAt || null, followedUpAt: l.followedUpAt || null, updatedAt: l.updatedAt, createdAt: l.createdAt };
}

export async function listLeads({ batch, status } = {}) {
  const col = await leads();
  const q = {};
  if (LEAD_BATCHES.includes(batch)) q.batch = batch;
  if (LEAD_STATUSES.includes(status)) q.status = status;
  const rows = await col.find(q).sort({ batch: 1, createdAt: 1 }).limit(2000).toArray();
  const counts = await col.aggregate([{ $group: { _id: { batch: "$batch", status: "$status" }, n: { $sum: 1 } } }]).toArray();
  return { leads: rows.map(serializeLead), counts: counts.map((c) => ({ batch: c._id.batch, status: c._id.status, n: c.n })) };
}

export async function createLead(input) {
  const data = clean(input);
  const batch = String(input.batch || "").toUpperCase();
  if (!LEAD_BATCHES.includes(batch)) return { error: "batch must be PK, UK, US or EU.", status: 400 };
  if (!data.company) return { error: "Company is required.", status: 400 };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email || "")) return { error: "A valid email is required.", status: 400 };
  const col = await leads();
  const now = new Date().toISOString();
  try {
    const r = await col.insertOne({ ...data, batch, status: "NEW", createdAt: now, updatedAt: now });
    return { lead: serializeLead({ _id: r.insertedId, ...data, batch, status: "NEW", createdAt: now, updatedAt: now }) };
  } catch (err) {
    if (err?.code === 11000) return { error: "A lead with that email already exists.", status: 409 };
    throw err;
  }
}

export async function updateLead(id, input) {
  if (!ObjectId.isValid(id)) return { error: "Invalid lead id.", status: 400 };
  const set = clean(input);
  if (input.status !== undefined) {
    if (!LEAD_STATUSES.includes(input.status)) return { error: "Invalid status.", status: 400 };
    set.status = input.status;
  }
  set.updatedAt = new Date().toISOString();
  const col = await leads();
  const r = await col.findOneAndUpdate({ _id: new ObjectId(id) }, { $set: set }, { returnDocument: "after" });
  const doc = r?.value !== undefined ? r.value : r;
  if (!doc) return { error: "Lead not found.", status: 404 };
  return { lead: serializeLead(doc) };
}
