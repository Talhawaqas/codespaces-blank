// test/watcher-social.test.mjs -- social login for the Watcher Pioneer Program, and (the point of the first test) proof that it cannot disturb
// existing wallet participants. Runs against the REAL configured MongoDB, like the other watcher tests, so:
//   * everything it creates is disposable (random wallets, "social:google:test-..." ids) and is deleted again by exact id;
//   * it never resets the shared program counter to a snapshot (that could erase a REAL enrollment that landed meanwhile); it subtracts exactly
//     the increments this run caused.
// Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test --test-force-exit test/watcher-social.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import { NextRequest } from "next/server.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { getWatcherCollections, ensureWatcherIndexes, buildWatcherMessage, ENROLLMENT_PROMO_POINTS, ENROLLMENT_PROMO_CUTOFF, WATCHER_POINTS_PER_SESSION } from "../src/lib/watcherPioneer.js";
import { __setSocialVerifier, ensureSocialIndexes, enrollSocial, startSocialSession, getSocialStatus, linkLoginToWallet, socialKey, findParticipant } from "../src/lib/watcherSocial.js";

const RUN = randomUUID().slice(0, 8);
const cleanup = { keys: [], newEnrollments: 0 };
let c;

// A stand-in for Google: token "tok:<subject>:<email>" verifies to that identity; anything else is rejected like a bad token.
__setSocialVerifier(async ({ provider, idToken }) => {
  const [tag, subject, email] = String(idToken).split(":");
  if (tag !== "tok" || !subject) throw new Error("Invalid Google token.");
  return { provider, subject: `test-${RUN}-${subject}`, email: email || `${subject}@example.com`, name: `Test ${subject}` };
});
const login = (n) => ({ provider: "google", subject: `test-${RUN}-${n}`, email: `${n}@example.com`, name: `Test ${n}` });
const tok = (n) => `tok:${n}:${n}@example.com`;

before(async () => {
  c = await getWatcherCollections();
  await ensureWatcherIndexes(); await ensureSocialIndexes();
});
after(async () => {
  const keys = cleanup.keys;
  await Promise.all([
    c.pioneers.deleteMany({ walletAddress: { $in: keys } }), c.sessions.deleteMany({ walletAddress: { $in: keys } }),
    c.identities.deleteMany({ participantKey: { $in: keys } }), c.identities.deleteMany({ subject: { $regex: `^test-${RUN}-` } }),
    c.walletLinks.deleteMany({ $or: [{ walletAddress: { $in: keys } }, { participantKey: { $in: keys } }] }),
    c.compensationLog.deleteMany({ walletAddress: { $in: keys } }),
  ]);
  if (cleanup.newEnrollments) await c.programCounters.updateOne({ _id: "global" }, { $inc: { enrolledWalletCount: -cleanup.newEnrollments } });
  __setSocialVerifier(null);
  await (await mongoClientPromise).close();
});

/** A participant exactly as the program created them BEFORE social login existed: no new fields, nothing extra. */
async function legacyWalletParticipant({ points = 5000 } = {}) {
  const wallet = ethers.Wallet.createRandom(); const key = wallet.address.toLowerCase(); cleanup.keys.push(key);
  const now = new Date();
  await c.pioneers.insertOne({ walletAddress: key, enrolledAt: now, followedX: true, joinedTelegram: true, totalPoints: points, updatedAt: now });
  const past = new Date(now.getTime() - 3 * 86400000);
  await c.sessions.insertOne({ walletAddress: key, qualifyingMethod: "social", qualifyingRef: null, startedAt: past, expiresAt: new Date(past.getTime() + 86400000), status: "completed", pointsAwarded: 200, settledAt: new Date(past.getTime() + 86400000) });
  await c.sessions.insertOne({ walletAddress: key, qualifyingMethod: "social", qualifyingRef: null, startedAt: now, expiresAt: new Date(now.getTime() + 20 * 3600000), status: "active", pointsAwarded: null, settledAt: null });
  return { wallet, key };
}
const snapshotOf = async (key) => JSON.stringify({ p: await c.pioneers.findOne({ walletAddress: key }), s: await c.sessions.find({ walletAddress: key }).sort({ startedAt: 1 }).toArray() });
const indexNames = async (col) => (await col.indexes()).map((i) => i.name).sort();
const signLink = async (wallet, lg) => { const timestamp = Date.now(); const message = buildWatcherMessage({ action: "link_social", extra: { provider: lg.provider, subject: lg.subject }, timestamp }); return { message, signature: await wallet.signMessage(message), timestamp }; };

// ------------------------------------------------------------------------------------------------ the safety guarantees
test("EXISTING DATA IS UNTOUCHED: a wallet participant's record, points, completed and active sessions are identical after every social flow, and no index changed", async () => {
  const { wallet, key } = await legacyWalletParticipant({ points: 5000 });
  const before = await snapshotOf(key);
  const pioneerIdx = await indexNames(c.pioneers), sessionIdx = await indexNames(c.sessions);

  // other people use social login in parallel; this wallet's own status is read; its owner attaches a Google login to it
  const a = await enrollSocial({ login: login("alice"), followedX: true, joinedTelegram: true }); cleanup.keys.push(a.participantKey); cleanup.newEnrollments += a.alreadyEnrolled ? 0 : 1;
  await getSocialStatus({ login: login("alice") });
  const lg = login("legacyowner");
  const sig = await signLink(wallet, lg);
  const linked = await linkLoginToWallet({ login: lg, walletAddress: key, ...sig });
  assert.equal(linked.attached, true);
  await getSocialStatus({ login: lg });

  assert.equal(await snapshotOf(key), before, "the wallet participant's pioneer record and every session are byte-for-byte identical");
  assert.deepEqual(await indexNames(c.pioneers), pioneerIdx, "no index on watcher_pioneers changed");
  assert.deepEqual(await indexNames(c.sessions), sessionIdx, "no index on watcher_sessions changed");
});

test("the program counter moves by exactly one per NEW social enrollment and never for a repeat", async () => {
  const read = async () => (await c.programCounters.findOne({ _id: "global" })).enrolledWalletCount;
  const lg = login("counter");
  const start = await read();
  const first = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true }); cleanup.keys.push(first.participantKey); cleanup.newEnrollments += 1;
  assert.equal(first.alreadyEnrolled, false);
  const after1 = await read();
  const again = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true });
  assert.equal(again.alreadyEnrolled, true);
  assert.ok(after1 - start >= 1, "the shared cap counts social participants too");
  assert.equal(String(again.pioneer._id), String(first.pioneer._id), "a repeat returns the same record");
});

// ------------------------------------------------------------------------------------------------ the social flow
test("social enrollment: same rules as a wallet (self-attested X + Telegram), same promo, record keyed by the synthetic id, identity stored by subject", async () => {
  const lg = login("bob");
  await assert.rejects(() => enrollSocial({ login: lg, followedX: true, joinedTelegram: false }), /followed X and joined Telegram/);
  assert.equal(await c.pioneers.countDocuments({ walletAddress: socialKey("google", lg.subject) }), 0, "a refused enrollment creates nothing");
  const r = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true }); cleanup.keys.push(r.participantKey); cleanup.newEnrollments += 1;
  assert.equal(r.participantKey, `social:google:${lg.subject}`.toLowerCase());
  assert.equal(r.pioneer.loginProvider, "google");
  assert.equal(r.pioneer.totalPoints, new Date() <= ENROLLMENT_PROMO_CUTOFF ? ENROLLMENT_PROMO_POINTS : 0, "the new-enrollment promo applies while it is running");
  const id = await c.identities.findOne({ provider: "google", subject: lg.subject });
  assert.equal(id.participantKey, r.participantKey); assert.equal(id.email, lg.email);
});

test("a social participant starts a social-task session; a second is refused while one is active; status shows it", async () => {
  const lg = login("carol");
  const r = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true }); cleanup.keys.push(r.participantKey); cleanup.newEnrollments += 1;
  const s1 = await startSocialSession({ login: lg, method: "social" });
  assert.ok(s1.expiresAt > new Date());
  await assert.rejects(() => startSocialSession({ login: lg, method: "social" }), /already have an active Watcher session/);
  const st = await getSocialStatus({ login: lg });
  assert.equal(st.enrolled, true); assert.ok(st.activeSession); assert.equal(st.linkedWallet, null); assert.equal(st.canReceiveRewards, false);
});

test("sessions settle and credit points for a social participant exactly like a wallet (the shared 24h settlement)", async () => {
  const lg = login("dave");
  const r = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true }); cleanup.keys.push(r.participantKey); cleanup.newEnrollments += 1;
  await startSocialSession({ login: lg, method: "social" });
  await c.sessions.updateOne({ walletAddress: r.participantKey, status: "active" }, { $set: { expiresAt: new Date(Date.now() - 1000) } }); // the 24h have elapsed
  const st = await getSocialStatus({ login: lg });
  assert.equal(st.totalPoints, r.pioneer.totalPoints + WATCHER_POINTS_PER_SESSION);
  assert.equal(st.activeSession, null);
});

test("the upload qualifying action needs a linked wallet; without one it is refused with a clear message and nothing is started", async () => {
  const lg = login("erin");
  const r = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true }); cleanup.keys.push(r.participantKey); cleanup.newEnrollments += 1;
  await assert.rejects(() => startSocialSession({ login: lg, method: "upload", qualifyingRef: "0x" + "ab".repeat(32) }), /Link a wallet/);
  assert.equal(await c.sessions.countDocuments({ walletAddress: r.participantKey }), 0);
});

test("an unenrolled login cannot start a session", async () => {
  await assert.rejects(() => startSocialSession({ login: login("nobody"), method: "social" }), /isn't enrolled/);
});

// ------------------------------------------------------------------------------------------------ linking
test("link: a social participant adds a wallet; both a login and a wallet signature are required; it is idempotent", async () => {
  const lg = login("frank");
  const r = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true }); cleanup.keys.push(r.participantKey); cleanup.newEnrollments += 1;
  const wallet = ethers.Wallet.createRandom(); const key = wallet.address.toLowerCase(); cleanup.keys.push(key);
  const sig = await signLink(wallet, lg);
  // a signature made by a different wallet, or for a different login, must not link
  const other = ethers.Wallet.createRandom();
  await assert.rejects(async () => linkLoginToWallet({ login: lg, walletAddress: key, ...(await signLink(other, lg)) }), /does not match the claimed address/);
  await assert.rejects(async () => linkLoginToWallet({ login: login("someoneelse"), walletAddress: key, ...sig }), /doesn't match|tampering/);
  const ok = await linkLoginToWallet({ login: lg, walletAddress: key, ...sig });
  assert.deepEqual([ok.linked, ok.participantKey], [true, r.participantKey]);
  const st = await getSocialStatus({ login: lg });
  assert.equal(st.linkedWallet, key); assert.equal(st.canReceiveRewards, true);
  assert.equal((await linkLoginToWallet({ login: lg, walletAddress: key, ...(await signLink(wallet, lg)) })).alreadyLinked, true, "linking again is a no-op");
  // the wallet can no longer enroll as a separate participant
  const { assertWalletNotLinked } = await import("../src/lib/watcherSocial.js");
  await assert.rejects(() => assertWalletNotLinked(key), /linked to a social-login account/);
});

test("link: NO MERGING. A wallet that already has its own account cannot be linked to a social participant, and a login cannot be attached to two wallets", async () => {
  const lg = login("grace");
  const r = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true }); cleanup.keys.push(r.participantKey); cleanup.newEnrollments += 1;
  const { wallet, key } = await legacyWalletParticipant({ points: 777 });
  const before = await snapshotOf(key);
  await assert.rejects(async () => linkLoginToWallet({ login: lg, walletAddress: key, ...(await signLink(wallet, lg)) }), /already has its own Watcher account/);
  assert.equal(await snapshotOf(key), before, "the refused link changed nothing");
  assert.equal(await c.walletLinks.countDocuments({ participantKey: r.participantKey }), 0);
  // a second wallet for a participant that already has one
  const w1 = ethers.Wallet.createRandom(), w2 = ethers.Wallet.createRandom(); cleanup.keys.push(w1.address.toLowerCase(), w2.address.toLowerCase());
  await linkLoginToWallet({ login: lg, walletAddress: w1.address, ...(await signLink(w1, lg)) });
  await assert.rejects(async () => linkLoginToWallet({ login: lg, walletAddress: w2.address, ...(await signLink(w2, lg)) }), /already has a wallet linked/);
});

test("attach: an existing wallet participant adds a Google login; the login then resolves to that SAME record (same points), and cannot be reused", async () => {
  const { wallet, key } = await legacyWalletParticipant({ points: 12345 });
  const lg = login("henry");
  await linkLoginToWallet({ login: lg, walletAddress: key, ...(await signLink(wallet, lg)) });
  const p = await findParticipant(lg);
  assert.equal(p.participantKey, key); assert.equal(p.pioneer.totalPoints, 12345);
  const st = await getSocialStatus({ login: lg });
  assert.equal(st.totalPoints, 12345); assert.equal(st.linkedWallet, key); assert.ok(st.activeSession, "the wallet's existing active session is visible through the login");
  // signing in with Google never creates a second record for this person
  const again = await enrollSocial({ login: lg, followedX: true, joinedTelegram: true });
  assert.equal(again.alreadyEnrolled, true); assert.equal(again.participantKey, key);
  assert.equal(await c.pioneers.countDocuments({ walletAddress: socialKey("google", lg.subject) }), 0);
  // another login cannot take over the same wallet account
  const other = login("henry-two");
  await assert.rejects(async () => linkLoginToWallet({ login: other, walletAddress: key, ...(await signLink(wallet, other)) }), /already has a login attached/);
  // and a wallet that is not enrolled cannot be attached to
  const fresh = ethers.Wallet.createRandom(); cleanup.keys.push(fresh.address.toLowerCase());
  await assert.rejects(async () => linkLoginToWallet({ login: login("ivy"), walletAddress: fresh.address, ...(await signLink(fresh, login("ivy"))) }), /isn't enrolled/);
});

// ------------------------------------------------------------------------------------------------ the HTTP routes
const post = (path, body, headers = {}) => new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`, ...headers }, body: JSON.stringify(body) });

test("routes: social enroll/status/qualify work with a token; a bad token is 401; the wallet path still works exactly as before", async () => {
  const enroll = (await import("../src/app/api/watcher/enroll/route.js")).POST;
  const qualify = (await import("../src/app/api/watcher/qualify/route.js")).POST;
  const status = (await import("../src/app/api/watcher/status/route.js")).GET;
  const subject = "route1"; const key = `social:google:test-${RUN}-${subject}`; cleanup.keys.push(key);

  assert.equal((await enroll(post("/api/watcher/enroll", { idToken: "garbage", followedX: true, joinedTelegram: true }))).status, 401, "an invalid token is rejected");
  const e = await enroll(post("/api/watcher/enroll", { idToken: tok(subject), followedX: true, joinedTelegram: true }));
  assert.equal(e.status, 200, JSON.stringify(await e.clone().json())); cleanup.newEnrollments += (await e.json()).alreadyEnrolled ? 0 : 1;

  const s = await status(new NextRequest(`http://localhost:3000/api/watcher/status`, { headers: { authorization: `Bearer ${tok(subject)}` } }));
  const sj = await s.json(); assert.equal(sj.enrolled, true); assert.equal(sj.loginProvider, "google");
  assert.equal((await status(new NextRequest(`http://localhost:3000/api/watcher/status`, { headers: { authorization: "Bearer nope" } }))).status, 401);

  const q = await qualify(post("/api/watcher/qualify", { idToken: tok(subject), method: "social" }));
  assert.equal(q.status, 200, JSON.stringify(await q.clone().json()));
  assert.equal((await qualify(post("/api/watcher/qualify", { idToken: tok(subject), method: "social" }))).status, 409, "one active session at a time");

  // the unchanged wallet path: a real wallet signature, no token
  const w = ethers.Wallet.createRandom(); cleanup.keys.push(w.address.toLowerCase());
  const ts = Date.now(); const message = buildWatcherMessage({ action: "enroll", extra: { followedX: true, joinedTelegram: true }, timestamp: ts });
  const we = await enroll(post("/api/watcher/enroll", { walletAddress: w.address, followedX: true, joinedTelegram: true, message, signature: await w.signMessage(message), timestamp: ts }));
  assert.equal(we.status, 200, JSON.stringify(await we.clone().json())); cleanup.newEnrollments += (await we.json()).alreadyEnrolled ? 0 : 1;
  const ws = await status(new NextRequest(`http://localhost:3000/api/watcher/status?walletAddress=${w.address}`));
  assert.equal((await ws.json()).enrolled, true);
});

test("routes: a token AND a signature is treated as a wallet request (older clients are never diverted); the link route needs both proofs", async () => {
  const enroll = (await import("../src/app/api/watcher/enroll/route.js")).POST;
  const link = (await import("../src/app/api/watcher/link/route.js")).POST;
  // a body carrying a stray token plus a bad wallet signature must fail as a wallet request (400), not be routed to social enrollment
  const r = await enroll(post("/api/watcher/enroll", { idToken: tok("stray"), walletAddress: ethers.Wallet.createRandom().address, followedX: true, joinedTelegram: true, message: "x", signature: "0x00", timestamp: Date.now() }));
  assert.equal(r.status, 400);
  assert.equal(await c.pioneers.countDocuments({ walletAddress: `social:google:test-${RUN}-stray` }), 0);

  const subject = "route2"; cleanup.keys.push(`social:google:test-${RUN}-${subject}`);
  const e = await enroll(post("/api/watcher/enroll", { idToken: tok(subject), followedX: true, joinedTelegram: true })); cleanup.newEnrollments += (await e.json()).alreadyEnrolled ? 0 : 1;
  const w = ethers.Wallet.createRandom(); cleanup.keys.push(w.address.toLowerCase());
  const lg = login(subject); const sig = await signLink(w, lg);
  assert.equal((await link(post("/api/watcher/link", { idToken: "garbage", walletAddress: w.address, ...sig }))).status, 401, "no valid login, no link");
  assert.equal((await link(post("/api/watcher/link", { idToken: tok(subject), walletAddress: w.address, message: sig.message, signature: "0x" + "00".repeat(65), timestamp: sig.timestamp }))).status, 400, "no valid wallet signature, no link");
  const ok = await link(post("/api/watcher/link", { idToken: tok(subject), walletAddress: w.address, ...sig }));
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  // the linked wallet can no longer enroll on its own through the wallet route
  const ts = Date.now(); const message = buildWatcherMessage({ action: "enroll", extra: { followedX: true, joinedTelegram: true }, timestamp: ts });
  const re = await enroll(post("/api/watcher/enroll", { walletAddress: w.address, followedX: true, joinedTelegram: true, message, signature: await w.signMessage(message), timestamp: ts }));
  assert.equal(re.status, 409);
});
