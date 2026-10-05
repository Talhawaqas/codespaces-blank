// test/_chat-fixtures.mjs -- real-MongoDB fixtures for the Secure Chat tests. Real organizations, members, sessions, device and
// KeyPackage records, real MLS on the client side. Everything created here is removed by exact id in teardown().

import { randomBytes } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { chatDb } from "../src/lib/chat/common.js";
import { ChatClient } from "../src/lib/chat/client/ChatClient.js";
import { DirectApi } from "../src/lib/chat/client/directApi.js";
import { MemoryStore, SealedStore, createSealer } from "../src/lib/chat/client/stores.js";

export const RUN = randomBytes(3).toString("hex");
export const created = { orgIds: [], emails: [] };
export let c;

export async function setup() { await ensureOrgIndexes(); c = await getOrgCollections(); await chatDb(); return c; }

export async function makeChatOrg(label, { people = ["alice", "bob", "carol", "dave"], settings = null } = {}) {
  const now = new Date().toISOString();
  const orgId = (await c.orgs.insertOne({ name: `chat-${RUN}-${label}`, createdAt: now, ...(settings ? { chatSettings: settings } : {}) })).insertedId;
  created.orgIds.push(orgId);
  const mk = async (k, role = "member") => {
    const email = `chat-${RUN}-${label}-${k}@example.com`; created.emails.push(email);
    await c.orgMembers.insertOne({ orgId, email, role, departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
    return { email, membership: await c.orgMembers.findOne({ orgId, email }) };
  };
  const out = { orgId, oid: String(orgId), owner: await mk("owner", "owner") };
  for (const p of people) out[p] = await mk(p);
  return out;
}

/** A device: its own sealed store, its own server adapter. Call await client.init() to enroll. */
export async function client(org, who, { label = "Test device", jitterMs = 0, onSecurityEvent } = {}) {
  const store = new SealedStore(new MemoryStore(), await createSealer(randomBytes(32)));
  const events = [];
  const cl = new ChatClient({ api: new DirectApi({ orgId: org.oid, membership: who.membership, email: who.email }), store, orgId: org.oid, email: who.email, label, platform: "web", jitterMs, onSecurityEvent: (e) => { events.push(e); onSecurityEvent?.(e); } });
  cl.securityEvents = events;
  await cl.init();
  return cl;
}

export async function cookieFor(email) { return (await createSession(email)).sessionToken; }

export async function teardown() {
  const k = await chatDb();
  const orgIds = created.orgIds.map(String);
  const convIds = (await k.conversations.find({ orgId: { $in: orgIds } }).project({ _id: 1 }).toArray()).map((x) => x._id);
  const byConv = { conversationId: { $in: convIds } };
  await Promise.all([k.messages, k.envelopes, k.readStates, k.typing, k.attachments, k.participants].map((col) => col.deleteMany(byConv)));
  await k.db.collection("chat_blob_parts").deleteMany(byConv);
  const byOrg = { orgId: { $in: orgIds } };
  await Promise.all([k.conversations, k.devices, k.keyPackages, k.presence, k.securityEvents, k.deliveries, k.contacts, k.contactRequests, k.prefs].map((col) => col.deleteMany(byOrg)));
  await k.contactBlocks.deleteMany({ $or: [{ blocker: { $in: created.emails } }, { blocked: { $in: created.emails } }] });
  await k.contactRequests.deleteMany({ $or: [{ from: { $in: created.emails } }, { to: { $in: created.emails } }] });
  const ids = { $in: created.orgIds };
  await Promise.all(["orgMembers", "orgActivity", "auditChainEntries", "auditChainHeads"].map((n) => c[n].deleteMany({ orgId: ids })));
  await c.db.collection("notifications").deleteMany({ orgId: ids });
  await c.db.collection("sessions").deleteMany({ email: { $in: created.emails } }).catch(() => {});
  await c.orgs.deleteMany({ _id: ids });
  await c.db.collection("rate_limit_hits").deleteMany({ key: { $regex: RUN } }).catch(() => {});
  await (await mongoClientPromise).close();
}

export const text = (u8) => new TextDecoder().decode(u8);
