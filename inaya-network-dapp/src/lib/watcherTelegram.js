// src/lib/watcherTelegram.js
//
// "Continue with Telegram" for the Watcher Pioneer Program (see watcherSocial.js for how a login becomes a participant).
//
// Telegram has no ID token to verify, so sign-in goes through the program's own bot:
//   1. the app asks for a login   -> we create a one-time code and return a link  https://t.me/<bot>?start=<code>
//   2. the person opens it in Telegram and presses Start -> Telegram calls our webhook with their user id
//   3. the bot asks "Sign in to Inaya Watcher?" with Yes / No buttons; only the SAME Telegram user can press them
//   4. the app polls with the code; once confirmed it receives a signed session token, exactly once
// The token (30 days) is then used like Google's ID token on the existing routes: { provider: "telegram", idToken: <token> }.
//
// The identity is the Telegram user id (stable; usernames can change). Nothing here is secret-free: it needs TELEGRAM_BOT_TOKEN (and the bot's
// username); both session signing and the webhook secret are derived from the bot token, so no extra secret has to be provisioned.
// If TELEGRAM_GROUP_CHAT is set (e.g. "@inayanetwork") and the bot is in that group, "joined the Telegram group" is VERIFIED with
// getChatMember instead of self-attested.
//
// Honest limit: a login link can be sent to someone else ("press Start on this"); the confirm step names what they are signing in to and says
// to ignore it if they did not start it, but a person who confirms anyway signs the sender in as them. The stake here is Watcher points.

import crypto from "node:crypto";
import { getWatcherCollections } from "./watcherPioneer.js";

const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const cfg = () => ({ token: process.env.TELEGRAM_BOT_TOKEN || "", bot: (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, ""), group: process.env.TELEGRAM_GROUP_CHAT || "" });
export const telegramEnabled = () => { const c = cfg(); return !!(c.token && c.bot); };
export const groupCheckEnabled = () => telegramEnabled() && !!cfg().group;

let apiOverride = null;
/** Test hook: replaces the calls to Telegram's Bot API. */
export function __setTelegramApi(fn) { apiOverride = fn; }
async function botApi(method, params) {
  if (apiOverride) return apiOverride(method, params);
  const res = await fetch(`https://api.telegram.org/bot${cfg().token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

const hmac = (key, msg) => crypto.createHmac("sha256", key).update(msg).digest();
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sessionKey = () => hmac(cfg().token, "inaya-watcher-session-v1");
/** The secret Telegram must send back in X-Telegram-Bot-Api-Secret-Token (set once with setWebhook; see scripts/telegram-setup.mjs). */
export const webhookSecret = () => hmac(cfg().token, "inaya-watcher-webhook").toString("hex");

// ------------------------------------------------------------------------------------------------ session tokens
export function signSession({ id, name }, ttlMs = SESSION_TTL_MS) {
  const payload = b64u(JSON.stringify({ v: 1, sub: String(id), name: name || null, exp: Date.now() + ttlMs }));
  return `${payload}.${b64u(hmac(sessionKey(), payload))}`;
}
export function verifySession(token) {
  if (!telegramEnabled()) throw new Error("Telegram sign-in isn't configured on this server.");
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) throw new Error("Invalid Telegram session.");
  const expected = hmac(sessionKey(), payload);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new Error("Invalid Telegram session.");
  let p; try { p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("Invalid Telegram session."); }
  if (p.v !== 1 || !p.sub) throw new Error("Invalid Telegram session.");
  if (!(p.exp > Date.now())) throw new Error("Your Telegram sign-in expired. Please sign in again.");
  return { subject: String(p.sub), name: p.name || null };
}

// ------------------------------------------------------------------------------------------------ login codes
let indexed = false;
async function logins() {
  const { db } = await getWatcherCollections();
  const col = db.collection("watcher_telegram_logins");
  if (!indexed) { await Promise.all([col.createIndex({ code: 1 }, { unique: true }), col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })]); indexed = true; }
  return col;
}

export async function startTelegramLogin() {
  if (!telegramEnabled()) throw Object.assign(new Error("Telegram sign-in isn't available yet."), { status: 503 });
  const code = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  await (await logins()).insertOne({ code, status: "pending", createdAt: new Date(now), expiresAt: new Date(now + CODE_TTL_MS) });
  return { code, url: `https://t.me/${cfg().bot}?start=${code}`, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
}

const displayName = (u) => u.username ? `@${u.username}` : [u.first_name, u.last_name].filter(Boolean).join(" ") || String(u.id);

/** Handles one update from Telegram. Never throws for a bad update: Telegram retries failed webhooks, so every update is acknowledged. */
export async function handleTelegramUpdate(update) {
  const col = await logins();
  const now = new Date();
  const msg = update?.message;
  if (msg?.text && msg.chat?.type === "private" && msg.from && !msg.from.is_bot) {
    const m = msg.text.match(/^\/start(?:@\w+)?\s+([a-f0-9]{32})$/i);
    if (!m) { await botApi("sendMessage", { chat_id: msg.from.id, text: "Open the Inaya app and choose Continue with Telegram to sign in to the Watcher Pioneer Program." }).catch(() => {}); return; }
    const code = m[1].toLowerCase();
    const claimed = await col.findOneAndUpdate({ code, status: "pending", expiresAt: { $gt: now } }, { $set: { status: "awaiting_confirm", telegram: { id: msg.from.id, name: displayName(msg.from) }, startedAt: now } }, { returnDocument: "after" });
    const doc = claimed?.value !== undefined ? claimed.value : claimed;
    if (!doc) { await botApi("sendMessage", { chat_id: msg.from.id, text: "That sign-in link has expired or was already used. Start again from the Inaya app." }).catch(() => {}); return; }
    await botApi("sendMessage", {
      chat_id: msg.from.id,
      text: "Sign in to the Inaya Watcher Pioneer Program with this Telegram account?\n\nOnly confirm if you just chose Continue with Telegram in the Inaya app yourself. If someone else sent you this link, press No.",
      reply_markup: { inline_keyboard: [[{ text: "Yes, sign me in", callback_data: `ok:${code}` }, { text: "No", callback_data: `no:${code}` }]] },
    }).catch(() => {});
    return;
  }
  const cb = update?.callback_query;
  if (cb?.data && cb.from) {
    const m = cb.data.match(/^(ok|no):([a-f0-9]{32})$/);
    if (!m) return;
    const [, answer, code] = m;
    // only the same Telegram user who pressed Start can answer
    const res = await col.findOneAndUpdate({ code, status: "awaiting_confirm", "telegram.id": cb.from.id, expiresAt: { $gt: now } }, { $set: { status: answer === "ok" ? "claimed" : "denied", answeredAt: now } }, { returnDocument: "after" });
    const doc = res?.value !== undefined ? res.value : res;
    await botApi("answerCallbackQuery", { callback_query_id: cb.id, text: doc ? (answer === "ok" ? "Signed in. Go back to the Inaya app." : "Cancelled.") : "That request is no longer valid." }).catch(() => {});
  }
}

/** The app polls this. A confirmed login yields its session token exactly once. */
export async function pollTelegramLogin(code) {
  if (!/^[a-f0-9]{32}$/i.test(String(code || ""))) return { status: "expired" };
  const col = await logins();
  const doc = await col.findOne({ code: String(code).toLowerCase() });
  if (!doc || doc.expiresAt <= new Date()) return { status: "expired" };
  if (doc.status === "pending" || doc.status === "awaiting_confirm") return { status: "pending" };
  if (doc.status === "denied") return { status: "denied" };
  if (doc.status === "claimed") {
    const res = await col.findOneAndUpdate({ code: doc.code, status: "claimed" }, { $set: { status: "consumed", consumedAt: new Date() } }, { returnDocument: "after" });
    const won = res?.value !== undefined ? res.value : res;
    if (!won) return { status: "expired" }; // another poll took it
    const token = signSession({ id: won.telegram.id, name: won.telegram.name });
    return { status: "ready", token, subject: String(won.telegram.id), name: won.telegram.name, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
  }
  return { status: "expired" }; // consumed
}

// ------------------------------------------------------------------------------------------------ group membership
/** true / false when the group check is configured, null when it is not (then the person's own confirmation is used, as for wallets). */
export async function isGroupMember(userId) {
  if (!groupCheckEnabled()) return null;
  try {
    const r = await botApi("getChatMember", { chat_id: cfg().group, user_id: Number(userId) });
    return ["creator", "administrator", "member"].includes(r?.status) || (r?.status === "restricted" && r?.is_member === true);
  } catch (err) {
    // "user not found"/"participant" errors mean not a member; anything else (bot not in group, network) must not silently block or pass people
    if (/user not found|participant_id_invalid|USER_NOT_PARTICIPANT/i.test(String(err.message))) return false;
    throw err;
  }
}
