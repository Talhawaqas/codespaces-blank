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

// This is a testing hackathon, not a build-a-project one: there's nothing to
// submit except real bugs found across the live ecosystem. These constants
// are the single source of truth for both the rules copy rendered in
// HackathonSection.js and the enums the bug-report routes validate against
// -- keeps "what's in scope" and "what a report is allowed to say" in sync
// by construction instead of two places that can drift.

export const HACKATHON_TIMELINE = {
  start: "September 1, 2026",
  deadline: "November 1, 2026",
  winnersAnnounced: "Shortly after judging concludes (no fixed date -- triage takes as long as it takes to do properly).",
};

export const IN_SCOPE_LAYERS = [
  { id: "dapp-web", label: "dApp Web App" },
  { id: "business-workspace", label: "Business Workspace" },
  { id: "mobile-app", label: "Mobile App (Android Alpha)" },
  { id: "custody-sdk", label: "@inaya-network/custody-sdk (+ React package, CLI, create-inaya-dapp)" },
  { id: "node-daemon", label: "@inaya-network/node-daemon" },
  { id: "smart-contracts", label: "Smart Contracts (BSC Testnet)" },
  { id: "security-layer", label: "Security Layer / Inaya Firewall" },
  { id: "learn", label: "Inaya Learn" },
  { id: "metadata-backend", label: "Metadata Backend APIs" },
  { id: "other", label: "Other / not sure which layer" },
];

const VALID_LAYER_IDS = new Set(IN_SCOPE_LAYERS.map((l) => l.id));

export function isValidLayer(layerId) {
  return VALID_LAYER_IDS.has(layerId);
}

export const SEVERITY_LEVELS = [
  { id: "critical", label: "Critical", description: "Fund loss, encryption/access-control bypass, or another user's private data exposed." },
  { id: "high", label: "High", description: "A core flow is broken with no workaround." },
  { id: "medium", label: "Medium", description: "Degraded but there's a workaround." },
  { id: "low", label: "Low", description: "Cosmetic, copy, or minor UX issue." },
];

const VALID_SEVERITY_IDS = new Set(SEVERITY_LEVELS.map((s) => s.id));

export function isValidSeverity(severityId) {
  return VALID_SEVERITY_IDS.has(severityId);
}

export const RESPONSIBLE_DISCLOSURE_NOTICE =
  "Found something Critical -- something that could let someone steal funds, bypass encryption, or access another user's data? Do not post it publicly anywhere (Discord, Telegram, X). Submit it here only. It stays admin-only until it's fixed.";

export const JUDGING_NOTES =
  "Every report is triaged by the team and scored on severity × report quality (clear repro steps, evidence) × real impact. Duplicate reports are credited to whoever submitted first. The top 5 scored reports plus one Special/Community award fill the 6 prize slots below.";

export const ELIGIBILITY_NOTES = [
  "Anyone with a wallet can participate.",
  "One prize per person/team, even if you submit multiple valid reports.",
  "Reports must reflect original testing performed during the window above.",
  "Inaya team members and contractors are not eligible to win.",
];

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
