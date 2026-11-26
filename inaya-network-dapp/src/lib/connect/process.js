// src/lib/connect/process.js -- SOW C-F, I: what happens to each inbound WhatsApp message, after the webhook stored it.
//   claim (lease, max 3 attempts) -> opt-out keywords -> staff link code -> sender type -> conversation (AI or HUMAN)
//   -> documents to intake | staff to the business assistant | customers to verification + the customer assistant
//   -> hand-over to a person (AI pauses, after-hours message outside business hours) -> reply through messages.js
// Sender types: staff (a Business OS member who linked this number with a code from their own signed-in session),
// supplier (company allow-list), customer (everyone else). A phone number alone never unlocks personal records.
import { getOrgCollections, getMembership } from "../orgs.js";
import { ccol, oid, sid, clean, nowIso, K, getSettings, digits, sha256, isOpenNow, event, audit, maskPhone, connectEntitled } from "./core.js";
import { sendMessage, setOptOut } from "./messages.js";
import { intakeMedia } from "./intake.js";
import { businessAnswer, customerAnswer, historyFrom } from "./assistant.js";
import { markRead } from "./graph.js";

const LEASE_MS = 120000; const MAX_ATTEMPTS = 3; const VERIFY_MIN = 30; const CODE_MIN = 10;
const STOP = /^\s*(stop|unsubscribe|opt[\s-]?out)\s*$/i; const START = /^\s*(start|subscribe|opt[\s-]?in)\s*$/i;

// ------------------------------------------------------------------ staff linking (code from the signed-in app, sent from the phone)
export async function createLinkCode({ orgId, membership, email }) {
  if (!(await connectEntitled(orgId))) return { error: "Inaya Connect isn't enabled for this company.", status: 403 };
  const { getConnection } = await import("./connection.js"); const conn = await getConnection(orgId);
  if (!conn || conn.status !== "ACTIVE") return { error: "Your company's WhatsApp number isn't connected yet. An admin connects it under Inaya Connect › Connection.", status: 409 };
  const code = String(Math.floor(100000 + Math.random() * 900000)); const c = await ccol();
  await c.updateOne({ orgId: oid(orgId), kind: K.link, email, verified: false }, { $set: { codeHash: sha256(`${orgId}:${code}`), expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), opsDoc: true }, $setOnInsert: { orgId: oid(orgId), kind: K.link, email, verified: false, createdAt: nowIso() } }, { upsert: true });
  // One tap: wa.me opens WhatsApp on the company number with the message already written (QR for desktop users).
  const waLink = conn?.displayNumber ? `https://wa.me/${digits(conn.displayNumber)}?text=${encodeURIComponent(`LINK ${code}`)}` : null;
  void membership; return { code, waLink, sendTo: conn?.displayNumber || null, instructions: `On WhatsApp, send "LINK ${code}" to ${conn?.displayNumber || "your company's WhatsApp number"} within 15 minutes.` };
}
export async function listLinks({ orgId }) { const c = await ccol(); return (await c.find({ orgId: oid(orgId), kind: K.link, verified: true }).toArray()).map((l) => ({ email: l.email, number: maskPhone(l.number), linkedAt: l.linkedAt })); }
export async function unlink({ orgId, email, actorEmail }) { const c = await ccol(); const r = await c.deleteMany({ orgId: oid(orgId), kind: K.link, email }); await audit({ orgId, actorEmail, action: "CONNECT_STAFF_UNLINKED", metadata: { email } }); return { removed: r.deletedCount }; }
async function tryLink(orgId, from, text) {
  const m = /^\s*link\s+(\d{6})\s*$/i.exec(text || ""); if (!m) return null;
  const c = await ccol(); const pending = await c.findOne({ orgId: oid(orgId), kind: K.link, verified: false, codeHash: sha256(`${sid(orgId)}:${m[1]}`), expiresAt: { $gt: nowIso() } });
  if (!pending) return { reply: "That code isn't valid or has expired. Create a new one in Inaya Business OS (Inaya Connect › Link my WhatsApp)." };
  await c.deleteMany({ orgId: oid(orgId), kind: K.link, verified: true, $or: [{ number: from }, { email: pending.email }] });
  await c.updateOne({ _id: pending._id }, { $set: { verified: true, number: from, linkedAt: nowIso() }, $unset: { codeHash: "", expiresAt: "" } });
  await audit({ orgId, action: "CONNECT_STAFF_LINKED", metadata: { email: pending.email, number: maskPhone(from) } });
  return { reply: `Linked. This WhatsApp number now answers as ${pending.email} in Inaya. Ask things like "How much did we sell today?"` };
}

async function senderOf(orgId, from, settings) {
  const c = await ccol(); const link = await c.findOne({ orgId: oid(orgId), kind: K.link, verified: true, number: from });
  if (link) { const m = await getMembership(sid(orgId), link.email); if (m && m.status !== "removed") return { type: "staff", email: link.email, membership: { ...m, email: link.email } }; }
  if ((settings.allowedSupplierNumbers || []).includes(from)) return { type: "supplier" };
  return { type: "customer" };
}
async function conversation(orgId, from, profileName, senderType) {
  const c = await ccol(); const now = nowIso();
  const r = await c.findOneAndUpdate({ orgId: oid(orgId), kind: K.conv, number: from }, { $set: { lastInboundAt: now, lastMessageAt: now, audience: senderType, ...(profileName ? { profileName } : {}) }, $inc: { unread: 1 }, $setOnInsert: { orgId: oid(orgId), kind: K.conv, opsDoc: true, opsKey: `conv:${from}`, number: from, mode: "AI", status: "OPEN", createdAt: now } }, { upsert: true, returnDocument: "after" });
  return r;
}

// ------------------------------------------------------------------ customer verification (code to the CRM email)
async function startVerification(orgId, conv) {
  const { crmContacts } = await getOrgCollections(); const from = conv.number;
  const candidates = await crmContacts.find({ orgId: oid(orgId), deletedAt: null, phone: { $exists: true, $ne: null } }, { projection: { phone: 1, email: 1, name: 1 } }).limit(5000).toArray();
  const matches = candidates.filter((x) => { const p = digits(x.phone); return p.length >= 8 && (from.endsWith(p.slice(-10)) || p.endsWith(from.slice(-10))); });
  if (matches.length !== 1 || !matches[0].email) return { handover: "verification_unavailable" };
  const code = String(Math.floor(100000 + Math.random() * 900000)); const c = await ccol();
  await c.updateOne({ orgId: oid(orgId), kind: K.otp, number: from }, { $set: { contactId: matches[0]._id, codeHash: sha256(`${sid(orgId)}:${from}:${code}`), expiresAt: new Date(Date.now() + CODE_MIN * 60000).toISOString(), attempts: 0, opsDoc: true }, $setOnInsert: { orgId: oid(orgId), kind: K.otp, number: from, createdAt: nowIso() } }, { upsert: true });
  const { sendEmail } = await import("../email.js");
  await sendEmail({ to: matches[0].email, subject: "Your verification code", text: `Your code to continue on WhatsApp is ${code}. It expires in ${CODE_MIN} minutes. If you didn't ask for it, ignore this email.` }).catch(() => {});
  const masked = matches[0].email.replace(/^(.).*?(@.*)$/, "$1•••$2");
  await event({ orgId, type: "customer_verification", outcome: "code_sent", contact: from });
  return { reply: `To protect your details, we sent a 6-digit code to ${masked}. Reply here with the code.` };
}
async function tryCode(orgId, conv, text) {
  const m = /^\s*(\d{6})\s*$/.exec(text || ""); if (!m) return null;
  const c = await ccol(); const otp = await c.findOne({ orgId: oid(orgId), kind: K.otp, number: conv.number });
  if (!otp?.codeHash) return null;
  if (otp.expiresAt < nowIso() || otp.attempts >= 5) { await c.deleteOne({ _id: otp._id }); await event({ orgId, type: "customer_verification", outcome: "expired_or_locked", contact: conv.number }); return { reply: "That code has expired. Ask your question again and we'll send a new one." }; }
  if (otp.codeHash !== sha256(`${sid(orgId)}:${conv.number}:${m[1]}`)) { await c.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } }); await event({ orgId, type: "customer_verification", outcome: "wrong_code", contact: conv.number }); return { reply: "That code isn't right. Please check the email and try again." }; }
  await c.deleteOne({ _id: otp._id });
  await c.updateOne({ _id: conv._id }, { $set: { verifiedContactId: otp.contactId, verifiedUntil: new Date(Date.now() + VERIFY_MIN * 60000).toISOString() } });
  await event({ orgId, type: "customer_verification", outcome: "verified", contact: conv.number });
  return { reply: "Thanks, you're verified for the next 30 minutes. What would you like to know?", verified: true };
}

async function handover(orgId, conv, reason, settings, conn) {
  const c = await ccol(); await c.updateOne({ _id: conv._id }, { $set: { mode: "HUMAN", status: "OPEN", handoverReason: clean(reason, 200), handoverAt: nowIso() } });
  await event({ orgId, type: "handover", outcome: "to_human", contact: conv.number, detail: { reason: clean(reason, 80) } });
  const { notifyMember } = await import("../ops/core.js");
  const { getOrgCollections: g } = await import("../orgs.js"); const { orgMembers } = await g();
  const agents = await orgMembers.find({ orgId: oid(orgId), status: "active", $or: [{ role: { $in: ["owner", "admin"] } }, { supportRole: { $in: ["agent", "manager"] } }] }, { projection: { email: 1 } }).limit(20).toArray();
  for (const a of agents) await notifyMember({ orgId, email: a.email, title: "WhatsApp: a customer needs a person", body: "Open Inaya Connect › Inbox.", type: "connect_handover", sourceId: conv._id, dedupeKey: `connect:handover:${conv._id}:${new Date().toISOString().slice(0, 13)}:${a.email}` });
  const open = isOpenNow(settings.hours);
  return open ? "I'm passing you to a member of our team. They'll reply here shortly." : settings.afterHours;
  void conn;
}

/** Process one stored inbound message. */
async function handle(orgId, conn, msg) {
  const settings = await getSettings(orgId); const from = msg.from; const text = msg.text || "";
  const reply = (t, opts = {}) => sendMessage({ orgId, conn, to: from, text: t, kind: opts.kind || "reply", convId: opts.convId, aiGenerated: !!opts.ai });
  markRead(conn, msg.waMessageId);
  if (STOP.test(text)) { await setOptOut(orgId, from, true); await event({ orgId, type: "opt_out", outcome: "opted_out", contact: from }); await reply("You won't get any more messages from us here. Send START to turn messages back on.", { kind: "optout_confirm" }); return "opt_out"; }
  if (START.test(text)) { await setOptOut(orgId, from, false); await event({ orgId, type: "opt_out", outcome: "opted_in", contact: from }); await reply("Messages are back on. How can we help?"); return "opt_in"; }
  const c0 = await ccol(); const recentCount = await c0.countDocuments({ orgId: oid(orgId), kind: K.msg, direction: "in", from, at: { $gte: new Date(Date.now() - 3600000).toISOString() } });
  if (recentCount > settings.limits.perSenderPerHour) { await event({ orgId, type: "rate_limit", outcome: "sender_limited", contact: from }); if (recentCount === settings.limits.perSenderPerHour + 1) await reply("You've sent a lot of messages in the last hour. Please wait a little; our team will see them."); return "rate_limited"; }
  const linked = await tryLink(orgId, from, text); if (linked) { await reply(linked.reply); return "link"; }
  const sender = await senderOf(orgId, from, settings);
  const conv = await conversation(orgId, from, msg.profileName, sender.type);
  const c = await ccol(); await c.updateOne({ _id: msg._id }, { $set: { convId: conv._id } });
  if (msg.media) { const r = await intakeMedia({ orgId, conn, msg, sender }); if (r.ack) await reply(r.ack, { convId: conv._id }); if (conv.mode === "HUMAN") return `intake_${r.outcome}_human`; return `intake_${r.outcome}`; }
  // A person handling the chat pauses the CUSTOMER assistant only; linked staff always reach the business assistant.
  if (conv.mode === "HUMAN" && sender.type !== "staff") { await event({ orgId, type: "message", outcome: "for_human", contact: from }); return "human"; }
  if (!text.trim()) return "empty";
  const { orgs } = await getOrgCollections(); const org = await orgs.findOne({ _id: oid(orgId) }, { projection: { name: 1 } }); const orgName = org?.name || "our company";
  const recent = await c.find({ orgId: oid(orgId), kind: K.msg, convId: conv._id, _id: { $ne: msg._id } }).sort({ at: -1 }).limit(8).toArray();
  const history = historyFrom(recent.reverse(), text);
  if (sender.type === "staff") {
    if (!settings.businessAssistant) { await reply("The business assistant is switched off for this company."); return "staff_off"; }
    let out; try { out = await businessAnswer({ orgId, membership: sender.membership, email: sender.email, orgName, history, userText: text }); } catch (e) { console.error("connect business assistant:", e?.message); out = { text: "I can't answer right now (the assistant is unavailable). Please check Inaya Business OS." }; }
    await reply(out.text || "I couldn't find an answer to that in your Inaya data.", { convId: conv._id, ai: true });
    await event({ orgId, type: "assistant", outcome: out.blocked ? "blocked" : "answered", contact: from, detail: { audience: "staff" } });
    return "staff_answer";
  }
  // customers and suppliers asking questions
  const code = await tryCode(orgId, conv, text); if (code) { await reply(code.reply, { convId: conv._id }); return "verify_code"; }
  if (!settings.customerAssistant) { const t = await handover(orgId, conv, "customer_assistant_off", settings, conn); await reply(conv.createdAt === conv.lastInboundAt ? `${settings.greeting.replace("{company}", orgName)} ${t}` : t, { convId: conv._id }); return "handover"; }
  const verified = !!(conv.verifiedContactId && conv.verifiedUntil > nowIso());
  let out; try { out = await customerAnswer({ orgId, orgName, contactId: sid(conv.verifiedContactId), verified, number: from, history, userText: text }); } catch (e) { console.error("connect customer assistant:", e?.message); out = { handover: "assistant_unavailable" }; }
  if (out.handover) { await reply(await handover(orgId, conv, out.handover, settings, conn), { convId: conv._id }); return "handover"; }
  if (/VERIFY_NEEDED/.test(out.text || "")) { const v = await startVerification(orgId, conv); if (v.handover) { await reply(await handover(orgId, conv, v.handover, settings, conn), { convId: conv._id }); return "handover"; } await reply(v.reply, { convId: conv._id }); return "verify_start"; }
  await reply(out.text || "Sorry, I didn't get that. Could you rephrase, or type 'person' to talk to our team?", { convId: conv._id, ai: true });
  await event({ orgId, type: "assistant", outcome: out.blocked ? "blocked" : "answered", contact: from, detail: { audience: "customer", verified } });
  return "customer_answer";
}

/** Claims and processes pending messages (webhook after-response + cron fallback). */
export async function processPending({ orgId = null, limit = 20 } = {}) {
  const c = await ccol(); let done = 0, failed = 0;
  for (let i = 0; i < limit; i++) {
    const now = nowIso();
    const msg = await c.findOneAndUpdate({ ...(orgId ? { orgId: oid(orgId) } : {}), kind: K.msg, direction: "in", $or: [{ processing: "PENDING", $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] }, { processing: "PROCESSING", leaseUntil: { $lt: now } }] }, { $set: { processing: "PROCESSING", leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() }, $inc: { attempts: 1 } }, { sort: { at: 1 }, returnDocument: "after" });
    if (!msg) break;
    const conn = await c.findOne({ _id: msg.connId, kind: K.conn });
    try {
      if (!conn || conn.status !== "ACTIVE") throw Object.assign(new Error("connection not active"), { permanent: true });
      // Company license (License Manager SOW 9.3): while a company is restricted, incoming messages are kept (nothing is lost)
      // but nothing is answered, routed or filed, so no company data leaves through WhatsApp. Same rule as support email.
      const { companyMayOperate } = await import("../licensing/gate.js");
      if (!(await companyMayOperate(msg.orgId))) {
        await c.updateOne({ _id: msg._id }, { $set: { processing: "DONE", outcome: "license_restricted", processedAt: nowIso() }, $unset: { leaseUntil: "" } }); done++;
        continue;
      }
      const outcome = await handle(sid(msg.orgId), conn, msg);
      await c.updateOne({ _id: msg._id }, { $set: { processing: "DONE", outcome, processedAt: nowIso() }, $unset: { leaseUntil: "" } }); done++;
    } catch (e) {
      const last = e.permanent || msg.attempts >= MAX_ATTEMPTS;
      await c.updateOne({ _id: msg._id }, { $set: { processing: last ? "FAILED" : "PENDING", lastError: clean(e.message, 200), nextAttemptAt: new Date(Date.now() + msg.attempts * 60000).toISOString() }, $unset: { leaseUntil: "" } });
      await event({ orgId: msg.orgId, type: "processing", outcome: last ? "failed" : "retry", waMessageId: msg.waMessageId, detail: { error: clean(e.message, 120) } }); failed++;
    }
  }
  return { done, failed };
}
