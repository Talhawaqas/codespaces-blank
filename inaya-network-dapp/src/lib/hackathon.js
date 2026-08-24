// src/lib/hackathon.js
//
// Backend source of truth for the Hackathon prize pool. The 6 prize slots
// and their amounts are fixed by the SOW's own prize table -- the admin
// only assigns which wallet address won which slot, never a custom amount,
// so "prevent allocation above 100,000 INAYA" is true by construction here,
// not just something checked at write time. This mirrors exactly what
// configureWinnersBatch() on InayaHackathonRewards will be fed at mainnet
// launch (see scripts/deploy-hackathon-rewards.js in the root contracts repo).

export const HACKATHON_TOTAL_POOL = 100000;

export const PRIZE_SLOTS = [
  { place: "1st", label: "🥇 1st Place", amount: 40000 },
  { place: "2nd", label: "🥈 2nd Place", amount: 25000 },
  { place: "3rd", label: "🥉 3rd Place", amount: 15000 },
  { place: "4th", label: "4th Place", amount: 10000 },
  { place: "5th", label: "5th Place", amount: 5000 },
  { place: "special", label: "🌟 Special / Community Award", amount: 5000 },
];

const VALID_PLACES = new Set(PRIZE_SLOTS.map((s) => s.place));

export function isValidPlace(place) {
  return VALID_PLACES.has(place);
}

export async function ensureHackathonIndexes(db) {
  await db.collection("hackathon_winners").createIndex({ place: 1 }, { unique: true });
}

/** Merges the fixed prize table with whatever winners are currently recorded. Always
 *  returns exactly 6 rows, in prize order, regardless of how many are filled in yet. */
export async function getWinners(db) {
  const docs = await db.collection("hackathon_winners").find({}).toArray();
  const byPlace = new Map(docs.map((d) => [d.place, d]));
  return PRIZE_SLOTS.map((slot) => {
    const winner = byPlace.get(slot.place);
    return {
      place: slot.place,
      label: slot.label,
      amount: slot.amount,
      walletAddress: winner ? winner.walletAddress : null,
      projectName: winner ? winner.projectName || null : null,
      claimed: winner ? !!winner.claimed : false,
    };
  });
}

export async function upsertWinner(db, { place, walletAddress, projectName }) {
  if (!isValidPlace(place)) {
    throw new Error(`Invalid place "${place}". Must be one of: ${[...VALID_PLACES].join(", ")}`);
  }
  if (!walletAddress || typeof walletAddress !== "string" || !walletAddress.startsWith("0x")) {
    throw new Error("A valid walletAddress is required.");
  }
  const now = new Date().toISOString();
  await db.collection("hackathon_winners").updateOne(
    { place },
    {
      $set: { walletAddress: walletAddress.toLowerCase(), projectName: projectName || null, updatedAt: now },
      $setOnInsert: { place, claimed: false, createdAt: now },
    },
    { upsert: true }
  );
  return getWinners(db);
}

export async function clearWinner(db, place) {
  if (!isValidPlace(place)) {
    throw new Error(`Invalid place "${place}".`);
  }
  await db.collection("hackathon_winners").deleteOne({ place });
  return getWinners(db);
}
