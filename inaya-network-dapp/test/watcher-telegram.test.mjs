// test/watcher-telegram.test.mjs -- Telegram sign-in for the Watcher Pioneer Program: the code flow (start, bot confirmation, one-time token),
// its security properties, the optional verified group-membership check, and the HTTP routes. Real MongoDB; Telegram's Bot API is played by a
// stand-in (STATUS of the real Telegram: UNVERIFIED until the bot is created and scripts/telegram-setup.mjs has been run).
// Like the other watcher tests this runs against the real configured database: everything created here is disposable and removed by exact id,
// and the shared program counter is only ever decremented by exactly the enrollments this run made.
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/watcher-telegram.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { NextRequest } from "next/server.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { getWatcherCollections, ensureWatcherIndexes, buildWatcherMessage } from "../src/lib/watcherPioneer.js";
import { __setTelegramApi, startTelegramLogin, handleTelegramUpdate, pollTelegramLogin, signSession, verifySession, webhookSecret, telegramEnabled, isGroupMember } from "../src/lib/watcherTelegram.js";
import { verifySocialLogin, enrollSocial, getSocialStatus, socialKey } from "../src/lib/watcherSocial.js";

const FAKE_TOKEN = "123456:TEST-token-not-a-real-bot";
process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN; process.env.TELEGRAM_BOT_USERNAME = "InayaWatcherTestBot"; delete process.env.TELEGRAM_GROUP_CHAT;

const RUN = randomUUID().slice(0, 8);
const uid = (n) => 9_000_000_000 + (parseInt(RUN, 16) % 900_000) * 10 + n; // numeric Telegram-style ids no real account has
const sent = []; let membership = { status: "member" };
__setTelegramApi(async (method, params) => { sent.push({ method, params }); if (method === "getChatMember") { if (membership === "error") throw new Error("Telegram getChatMember failed: bot is not a member of the chat"); if (membership === "notfound") throw new Error("Telegram getChatMember failed: Bad Request: user not found"); return membership; } return { ok: true }; });

const cleanup = { keys: [], codes: [], newEnrollments: 0 };
let c;
before(async () => { c = await getWatcherCollections(); await ensureWatcherIndexes(); });
after(async () => {
  const keys = cleanup.keys;
  await Promise.all([c.pioneers.deleteMany({ walletAddress: { $in: keys } }), c.sessions.deleteMany({ walletAddress: { $in: keys } }), c.identities.deleteMany({ participantKey: { $in: keys } }),
    c.walletLinks.deleteMany({ $or: [{ walletAddress: { $in: keys } }, { participantKey: { $in: keys } }] }), c.compensationLog.deleteMany({ walletAddress: { $in: keys } }),
    c.db.collection("watcher_telegram_logins").deleteMany({ code: { $in: cleanup.codes } })]);
  if (cleanup.newEnrollments) await c.programCounters.updateOne({ _id: "global" }, { $inc: { enrolledWalletCount: -cleanup.newEnrollments } });
  __setTelegramApi(null);
  await (await mongoClientPromise).close();
});

const botMessage = (code, id, name = "tester") => ({ update_id: 1, message: { message_id: 1, chat: { id, type: "private" }, from: { id, is_bot: false, first_name: name, username: name }, text: `/start ${code}` } });
const callback = (data, id) => ({ update_id: 2, callback_query: { id: `cb-${Math.random()}`, from: { id, is_bot: false, first_name: "x" }, data } });

/** Runs the whole sign-in for Telegram user `id` and returns the session token. */
async function signIn(id) {
  const { code } = await startTelegramLogin(); cleanup.codes.push(code);
  await handleTelegramUpdate(botMessage(code, id));
  await handleTelegramUpdate(callback(`ok:${code}`, id));
  const r = await pollTelegramLogin(code);
  assert.equal(r.status, "ready"); return r;
}

test("start returns a one-time code and a t.me link for the bot; it is off (503) when no bot is configured", async () => {
  assert.equal(telegramEnabled(), true);
  const s = await startTelegramLogin(); cleanup.codes.push(s.code);
  assert.match(s.code, /^[a-f0-9]{32}$/); assert.equal(s.url, `https://t.me/InayaWatcherTestBot?start=${s.code}`); assert.ok(Date.parse(s.expiresAt) > Date.now());
  assert.deepEqual(await pollTelegramLogin(s.code), { status: "pending" });
  const keep = process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_BOT_TOKEN;
  try { assert.equal(telegramEnabled(), false); await assert.rejects(() => startTelegramLogin(), (e) => e.status === 503); } finally { process.env.TELEGRAM_BOT_TOKEN = keep; }
});

test("the full flow: Start in Telegram, the bot asks Yes/No, only the SAME user can answer, and the token is given out exactly once", async () => {
  const me = uid(1), other = uid(2);
  const { code } = await startTelegramLogin(); cleanup.codes.push(code);
  sent.length = 0;
  await handleTelegramUpdate(botMessage(code, me, "alice"));
  const ask = sent.find((s) => s.method === "sendMessage");
  assert.equal(ask.params.chat_id, me); assert.match(ask.params.text, /Only confirm if you just chose Continue with Telegram/);
  assert.deepEqual(ask.params.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`ok:${code}`, `no:${code}`]);
  assert.deepEqual(await pollTelegramLogin(code), { status: "pending" }, "not signed in until they confirm");
  await handleTelegramUpdate(callback(`ok:${code}`, other)); // somebody else presses the button
  assert.deepEqual(await pollTelegramLogin(code), { status: "pending" }, "a different Telegram user cannot confirm it");
  await handleTelegramUpdate(callback(`ok:${code}`, me));
  const ready = await pollTelegramLogin(code);
  assert.equal(ready.status, "ready"); assert.equal(ready.subject, String(me)); assert.equal(ready.name, "@alice");
  assert.deepEqual(await pollTelegramLogin(code), { status: "expired" }, "the token is handed out once; polling again gives nothing");
  const login = await verifySocialLogin({ provider: "telegram", idToken: ready.token });
  assert.deepEqual([login.provider, login.subject, login.email], ["telegram", String(me), null]);
});

test("pressing No denies the login; an unknown, malformed or reused code does nothing", async () => {
  const id = uid(3);
  const { code } = await startTelegramLogin(); cleanup.codes.push(code);
  await handleTelegramUpdate(botMessage(code, id)); await handleTelegramUpdate(callback(`no:${code}`, id));
  assert.deepEqual(await pollTelegramLogin(code), { status: "denied" });
  assert.deepEqual(await pollTelegramLogin("not-a-code"), { status: "expired" });
  assert.deepEqual(await pollTelegramLogin("0".repeat(32)), { status: "expired" });
  sent.length = 0; await handleTelegramUpdate(botMessage("f".repeat(32), id));
  assert.match(sent.find((s) => s.method === "sendMessage").params.text, /expired or was already used/);
  const s2 = await startTelegramLogin(); cleanup.codes.push(s2.code);
  await handleTelegramUpdate(botMessage(s2.code, uid(4))); sent.length = 0;
  await handleTelegramUpdate(botMessage(s2.code, uid(5))); // a second person tries to claim the same code
  assert.match(sent.find((s) => s.method === "sendMessage").params.text, /expired or was already used/, "a code can be started by one Telegram user only");
});

test("an expired code cannot be started or polled", async () => {
  const { code } = await startTelegramLogin(); cleanup.codes.push(code);
  await c.db.collection("watcher_telegram_logins").updateOne({ code }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.deepEqual(await pollTelegramLogin(code), { status: "expired" });
  sent.length = 0; await handleTelegramUpdate(botMessage(code, uid(6)));
  assert.match(sent.find((s) => s.method === "sendMessage").params.text, /expired or was already used/);
});

test("session tokens: tampered, signed with another bot's token, expired, or garbage are all rejected", async () => {
  const good = signSession({ id: uid(7), name: "bob" });
  assert.equal(verifySession(good).subject, String(uid(7)));
  const [payload, sig] = good.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, sub: "1", name: "victim", exp: Date.now() + 1e9 })).toString("base64url");
  assert.throws(() => verifySession(`${forged}.${sig}`), /Invalid Telegram session/);
  assert.throws(() => verifySession(`${payload}.${sig.slice(0, -2)}AA`), /Invalid Telegram session/);
  assert.throws(() => verifySession(signSession({ id: 1 }, -1000)), /expired/);
  assert.throws(() => verifySession("garbage"), /Invalid Telegram session/);
  assert.throws(() => verifySession(""), /Invalid Telegram session/);
  const keep = process.env.TELEGRAM_BOT_TOKEN; process.env.TELEGRAM_BOT_TOKEN = "999999:ANOTHER-BOT";
  try { assert.throws(() => verifySession(good), /Invalid Telegram session/, "a token from a different bot's key is not accepted"); } finally { process.env.TELEGRAM_BOT_TOKEN = keep; }
});

test("group membership: when the group check is on, joining is VERIFIED; non-members and lookup failures are not let through silently", async () => {
  process.env.TELEGRAM_GROUP_CHAT = "@inayatest";
  try {
    membership = { status: "member" }; assert.equal(await isGroupMember(uid(8)), true);
    membership = { status: "left" }; assert.equal(await isGroupMember(uid(8)), false);
    membership = { status: "restricted", is_member: true }; assert.equal(await isGroupMember(uid(8)), true);
    membership = "notfound"; assert.equal(await isGroupMember(uid(8)), false);
    membership = "error"; await assert.rejects(() => isGroupMember(uid(8)), /not a member of the chat/, "a broken check (e.g. bot not in the group) is an error, never a silent pass");

    // enrollment through Telegram with the check on
    const outsider = await signIn(uid(9)); membership = { status: "left" };
    const lo = await verifySocialLogin({ provider: "telegram", idToken: outsider.token });
    await assert.rejects(() => enrollSocial({ login: lo, followedX: true, joinedTelegram: true }), /Join the Inaya Telegram group first/);
    assert.equal(await c.pioneers.countDocuments({ walletAddress: socialKey("telegram", lo.subject) }), 0, "a refused enrollment creates nothing");

    membership = { status: "member" };
    const r = await enrollSocial({ login: lo, followedX: true, joinedTelegram: false }); // the person did not tick Telegram: the verified membership counts
    cleanup.keys.push(r.participantKey); cleanup.newEnrollments += 1;
    assert.equal(r.pioneer.joinedTelegram, true); assert.equal(r.pioneer.loginProvider, "telegram");
  } finally { delete process.env.TELEGRAM_GROUP_CHAT; membership = { status: "member" }; }
  assert.equal(await isGroupMember(uid(8)), null, "with no group configured the check reports 'not applicable'");
});

const post = (path, body, headers = {}) => new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}`, ...headers }, body: JSON.stringify(body) });

test("routes: the webhook only accepts Telegram's secret; start/poll/enroll/status/qualify work end to end with a Telegram token", async () => {
  const webhook = (await import("../src/app/api/watcher/telegram/webhook/route.js")).POST;
  const start = await import("../src/app/api/watcher/telegram/start/route.js");
  const poll = (await import("../src/app/api/watcher/telegram/poll/route.js")).GET;
  const enroll = (await import("../src/app/api/watcher/enroll/route.js")).POST;
  const qualify = (await import("../src/app/api/watcher/qualify/route.js")).POST;
  const status = (await import("../src/app/api/watcher/status/route.js")).GET;
  const id = uid(10);

  assert.equal((await webhook(post("/api/watcher/telegram/webhook", {}, {}))).status, 401, "no secret");
  assert.equal((await webhook(post("/api/watcher/telegram/webhook", {}, { "x-telegram-bot-api-secret-token": "wrong" }))).status, 401, "wrong secret");
  assert.equal((await webhook(post("/api/watcher/telegram/webhook", { nonsense: true }, { "x-telegram-bot-api-secret-token": webhookSecret() }))).status, 200, "an authentic but useless update is just acknowledged");
  assert.deepEqual(await (await start.GET()).json(), { enabled: true });

  const s = await (await start.POST(post("/api/watcher/telegram/start", {}))).json(); cleanup.codes.push(s.code);
  const hdr = { "x-telegram-bot-api-secret-token": webhookSecret() };
  assert.equal((await webhook(post("/api/watcher/telegram/webhook", botMessage(s.code, id, "route"), hdr))).status, 200);
  assert.equal((await webhook(post("/api/watcher/telegram/webhook", callback(`ok:${s.code}`, id), hdr))).status, 200);
  const p = await (await poll(new NextRequest(`http://localhost:3000/api/watcher/telegram/poll?code=${s.code}`))).json();
  assert.equal(p.status, "ready");

  const key = socialKey("telegram", id); cleanup.keys.push(key);
  const body = { provider: "telegram", idToken: p.token, followedX: true, joinedTelegram: true };
  const e = await enroll(post("/api/watcher/enroll", body)); assert.equal(e.status, 200, JSON.stringify(await e.clone().json())); cleanup.newEnrollments += (await e.json()).alreadyEnrolled ? 0 : 1;
  const st = await (await status(new NextRequest("http://localhost:3000/api/watcher/status?provider=telegram", { headers: { authorization: `Bearer ${p.token}` } }))).json();
  assert.equal(st.enrolled, true); assert.equal(st.loginProvider, "telegram"); assert.equal(st.linkedWallet, null);
  const q = await qualify(post("/api/watcher/qualify", { provider: "telegram", idToken: p.token, method: "social" })); assert.equal(q.status, 200);
  assert.equal((await qualify(post("/api/watcher/qualify", { provider: "telegram", idToken: p.token, method: "social" }))).status, 409, "one active session at a time");
  assert.equal((await enroll(post("/api/watcher/enroll", { ...body, idToken: "bogus" }))).status, 401, "a bad token is refused");
});

test("existing wallet data is untouched by Telegram flows, and a Telegram participant can link a wallet (both proofs needed)", async () => {
  const w = ethers.Wallet.createRandom(); const wkey = w.address.toLowerCase(); cleanup.keys.push(wkey);
  const now = new Date();
  await c.pioneers.insertOne({ walletAddress: wkey, enrolledAt: now, followedX: true, joinedTelegram: true, totalPoints: 4242, updatedAt: now });
  await c.sessions.insertOne({ walletAddress: wkey, qualifyingMethod: "social", qualifyingRef: null, startedAt: now, expiresAt: new Date(now.getTime() + 3600_000), status: "active", pointsAwarded: null, settledAt: null });
  const snap = async () => JSON.stringify([await c.pioneers.findOne({ walletAddress: wkey }), await c.sessions.find({ walletAddress: wkey }).toArray()]);
  const before = await snap();

  const t = await signIn(uid(11)); const login = await verifySocialLogin({ provider: "telegram", idToken: t.token });
  const r = await enrollSocial({ login, followedX: true, joinedTelegram: true }); cleanup.keys.push(r.participantKey); cleanup.newEnrollments += r.alreadyEnrolled ? 0 : 1;
  const { linkLoginToWallet } = await import("../src/lib/watcherSocial.js");
  const lw = ethers.Wallet.createRandom(); cleanup.keys.push(lw.address.toLowerCase());
  const ts = Date.now(); const message = buildWatcherMessage({ action: "link_social", extra: { provider: "telegram", subject: login.subject }, timestamp: ts });
  const ok = await linkLoginToWallet({ login, walletAddress: lw.address, message, signature: await lw.signMessage(message), timestamp: ts });
  assert.equal(ok.linked, true);
  const stt = await getSocialStatus({ login }); assert.equal(stt.linkedWallet, lw.address.toLowerCase()); assert.equal(stt.canReceiveRewards, true);
  // linking the legacy wallet (which has its own points) is refused: no merging
  const ts2 = Date.now(); const m2 = buildWatcherMessage({ action: "link_social", extra: { provider: "telegram", subject: login.subject }, timestamp: ts2 });
  await assert.rejects(async () => linkLoginToWallet({ login, walletAddress: w.address, message: m2, signature: await w.signMessage(m2), timestamp: ts2 }), /already (has|linked)|already has a wallet linked/);
  assert.equal(await snap(), before, "the legacy wallet participant's record and session are byte-for-byte unchanged");
});
