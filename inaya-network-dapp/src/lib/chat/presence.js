// src/lib/chat/presence.js
//
// Presence, typing and per-user chat preferences (SOW A2/A4: presence, appear-offline, typing). Everything here is
// ephemeral metadata: presence and typing rows expire by TTL index, and "appear offline" means the caller's heartbeat is
// not recorded at all and everyone sees "offline" (indistinguishable from really being offline).

import { LIMITS, chatDb, fail, nowIso, normEmail } from "./common.js";
import { assertAccess } from "./conversations.js";

export async function getPrefs({ orgId, email }) {
  const { prefs } = await chatDb();
  const p = await prefs.findOne({ orgId: String(orgId), email: normEmail(email) });
  return { appearOffline: !!p?.appearOffline, showSenderInNotifications: !!p?.showSenderInNotifications };
}

export async function setPrefs({ orgId, email, patch }) {
  const set = {};
  for (const k of ["appearOffline", "showSenderInNotifications"]) if (typeof patch?.[k] === "boolean") set[k] = patch[k];
  if (!Object.keys(set).length) fail(400, "Nothing to change.");
  const { prefs, presence } = await chatDb();
  await prefs.updateOne({ orgId: String(orgId), email: normEmail(email) }, { $set: { ...set, updatedAt: nowIso() }, $setOnInsert: { orgId: String(orgId), email: normEmail(email) } }, { upsert: true });
  if (set.appearOffline) await presence.deleteOne({ orgId: String(orgId), email: normEmail(email) });
  return getPrefs({ orgId, email });
}

export async function heartbeat({ orgId, email }) {
  const em = normEmail(email);
  const prefs = await getPrefs({ orgId, email: em });
  if (prefs.appearOffline) return { recorded: false };
  const { presence } = await chatDb();
  await presence.updateOne({ orgId: String(orgId), email: em }, { $set: { lastSeenAt: nowIso(), expiresAt: new Date(Date.now() + LIMITS.presenceTtlMs) }, $setOnInsert: { orgId: String(orgId), email: em } }, { upsert: true });
  return { recorded: true };
}

/** online | offline for people in the caller's own organization. Anyone else is simply absent from the answer. */
export async function getPresence({ orgId, emails }) {
  const list = [...new Set((emails || []).map(normEmail))].slice(0, 200);
  const { presence } = await chatDb();
  const rows = await presence.find({ orgId: String(orgId), email: { $in: list }, expiresAt: { $gt: new Date() } }).toArray();
  const online = new Set(rows.map((r) => r.email));
  return list.map((email) => ({ email, state: online.has(email) ? "online" : "offline" }));
}

export async function setTyping({ orgId, email, conversationId, typing = true }) {
  const em = normEmail(email);
  await assertAccess({ orgId, email: em, conversationId, statuses: ["active"] });
  const { typing: col } = await chatDb();
  if (!typing) { await col.deleteOne({ conversationId, email: em }); return { typing: false }; }
  const prefs = await getPrefs({ orgId, email: em });
  if (prefs.appearOffline) return { typing: false, suppressed: true };
  await col.updateOne({ conversationId, email: em }, { $set: { expiresAt: new Date(Date.now() + LIMITS.typingTtlMs) }, $setOnInsert: { conversationId, email: em } }, { upsert: true });
  return { typing: true };
}

export async function getTyping({ orgId, email, conversationId }) {
  await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  const { typing } = await chatDb();
  const rows = await typing.find({ conversationId, email: { $ne: normEmail(email) }, expiresAt: { $gt: new Date() } }).toArray();
  return rows.map((r) => r.email);
}
