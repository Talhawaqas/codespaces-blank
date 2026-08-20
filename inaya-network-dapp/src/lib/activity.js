// src/lib/activity.js
//
// DAU/WAU active-user tracking across all three surfaces (dApp, Business
// Workspace, mobile) in one shared, tiny collection. Same "public ping
// endpoint, fire-and-forget, admin-only read side" shape as Learn's
// analytics events (src/lib/learn.js), but tracking generic presence
// rather than named actions — nothing in this codebase did that before.
//
// One doc per identity+surface+day (upserted, not inserted per ping) —
// dedup is structural, not query-time logic. "Identity" is a wallet
// address when connected (dApp/mobile) or a stable anonymous id
// generated client-side and cached in localStorage/AsyncStorage
// otherwise, since most visitors browse before ever connecting a wallet
// and undercounting to "only wallet-connected sessions" would badly
// understate real usage. Business Workspace is always authenticated, so
// its identity is always the session email — no anonymous case there.

import { connectToDatabase } from "./mongodb.js";

export const ACTIVITY_SURFACES = ["dapp", "business", "mobile"];
const MAX_IDENTITY_LEN = 200;
const WAU_WINDOW_DAYS = 7;

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysAgoUtc(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function getActivityCollections() {
  const { db } = await connectToDatabase();
  return { db, pings: db.collection("activity_pings") };
}

let indexesEnsured = false;

export async function ensureActivityIndexes() {
  if (indexesEnsured) return;
  const { pings } = await getActivityCollections();
  await Promise.all([
    pings.createIndex({ surface: 1, identityId: 1, date: 1 }, { unique: true }),
    pings.createIndex({ surface: 1, date: 1 }),
  ]);
  indexesEnsured = true;
}

function isNonEmptyString(v, maxLen) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= maxLen;
}

/** Throws a descriptive Error on any violation — same fail-closed
 *  convention as validateFeedbackInput/validateSaveInput. */
export function validateActivityPingInput(input) {
  const { surface, identityId } = input || {};
  if (!ACTIVITY_SURFACES.includes(surface)) {
    throw new Error(`surface must be one of: ${ACTIVITY_SURFACES.join(", ")}.`);
  }
  if (!isNonEmptyString(identityId, MAX_IDENTITY_LEN)) {
    throw new Error("identityId is required.");
  }
  return { surface, identityId: identityId.trim() };
}

export async function recordActivityPing({ surface, identityId }) {
  await ensureActivityIndexes();
  const { pings } = await getActivityCollections();
  await pings.updateOne(
    { surface, identityId, date: todayUtc() },
    { $setOnInsert: { surface, identityId, date: todayUtc(), createdAt: new Date().toISOString() } },
    { upsert: true }
  );
}

/** DAU/WAU for one surface. Both computed via distinct() over the
 *  already-day-deduped docs — no separate rollup job needed since each
 *  identity collapses to exactly one doc per day at write time. */
export async function getActiveUserStats(surface) {
  await ensureActivityIndexes();
  const { pings } = await getActivityCollections();

  const [dauIds, wauIds] = await Promise.all([
    pings.distinct("identityId", { surface, date: todayUtc() }),
    pings.distinct("identityId", { surface, date: { $gte: daysAgoUtc(WAU_WINDOW_DAYS) } }),
  ]);

  return { dau: dauIds.length, wau: wauIds.length };
}

export async function getAllActiveUserStats() {
  const [dapp, business, mobile] = await Promise.all(ACTIVITY_SURFACES.map(getActiveUserStats));
  return { dapp, business, mobile };
}
