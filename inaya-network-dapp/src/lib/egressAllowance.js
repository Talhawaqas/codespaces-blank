// src/lib/egressAllowance.js
//
// Included retrieval for card (PAYG) customers: each calendar month a
// customer can retrieve up to the total size of what they have stored at no
// charge. Only retrieval beyond that goes to the egress checkout
// (create-egress-checkout-session). Wallet users are not gated at all:
// retrieval is a public read on the Custody contract.
//
// The month's usage is one counter document per (email, month), kept in the
// existing egress_unlocks collection under kind: "included_allowance" (the
// database is at its collection limit, so this does not add a collection).
// Paid unlocks in the same collection are keyed by { email, fileHash } and
// never carry `kind`, so the two never collide. The counter is incremented
// with a conditional update so two simultaneous retrievals cannot both take
// the last of the allowance; each granted retrieval is logged on the counter.

const COLLECTION = "egress_unlocks";
export const ALLOWANCE_KIND = "included_allowance";

let indexed = false;
async function ensureIndexes(db) {
  if (indexed) return;
  await db.collection(COLLECTION).createIndex(
    { email: 1, month: 1 },
    { unique: true, partialFilterExpression: { kind: ALLOWANCE_KIND }, name: "included_allowance_email_month" }
  );
  indexed = true;
}

/** "2026-11" for the given date, in UTC. */
export function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

/** Total bytes this customer has stored through card PAYG uploads. */
async function storedBytesFor(db, email) {
  const [row] = await db.collection("payg_assets").aggregate([
    { $match: { email } },
    { $group: { _id: null, total: { $sum: "$sizeBytes" } } },
  ]).toArray();
  return row?.total || 0;
}

/** This month's allowance for a customer: what they store, what they have retrieved, what is left. */
export async function getAllowance(db, rawEmail, now = new Date()) {
  const email = String(rawEmail).toLowerCase();
  const month = monthKey(now);
  const [storedBytes, counter] = await Promise.all([
    storedBytesFor(db, email),
    db.collection(COLLECTION).findOne({ kind: ALLOWANCE_KIND, email, month }, { projection: { usedBytes: 1 } }),
  ]);
  const usedBytes = counter?.usedBytes || 0;
  return { month, storedBytes, usedBytes, remainingBytes: Math.max(0, storedBytes - usedBytes) };
}

/**
 * Counts one retrieval of `fileHash` against this month's allowance.
 * @returns {{ granted: boolean, reason?: string, month, storedBytes, usedBytes, remainingBytes }}
 */
export async function claimIncludedRetrieval(db, rawEmail, fileHash, now = new Date()) {
  const email = String(rawEmail).toLowerCase();
  const month = monthKey(now);
  await ensureIndexes(db);

  const asset = await db.collection("payg_assets").findOne({ email, fileHash });
  if (!asset) return { granted: false, reason: "not_your_file", ...(await getAllowance(db, email, now)) };

  const sizeBytes = Number(asset.sizeBytes) || 0;
  const storedBytes = await storedBytesFor(db, email);
  const counters = db.collection(COLLECTION);

  await counters.updateOne(
    { kind: ALLOWANCE_KIND, email, month },
    { $setOnInsert: { kind: ALLOWANCE_KIND, email, month, usedBytes: 0, retrievals: [], createdAt: now } },
    { upsert: true }
  ).catch((err) => { if (err?.code !== 11000) throw err; }); // two first requests of the month racing to create the counter

  // Granted only if the whole file still fits in what is left of the month's allowance.
  const taken = await counters.updateOne(
    { kind: ALLOWANCE_KIND, email, month, usedBytes: { $lte: storedBytes - sizeBytes } },
    { $inc: { usedBytes: sizeBytes }, $push: { retrievals: { fileHash, sizeBytes, at: now } }, $set: { updatedAt: now } }
  );
  const granted = taken.modifiedCount === 1;

  const allowance = await getAllowance(db, email, now);
  return granted ? { granted, ...allowance } : { granted, reason: "allowance_used", ...allowance };
}
