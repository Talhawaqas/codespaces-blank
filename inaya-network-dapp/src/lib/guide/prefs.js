// src/lib/guide/prefs.js
//
// Command Palette + Virtual Guide SOW. Per-user ({orgId, email}) "read
// hints aloud" preference for the virtual guide's optional voice mode.
// Deliberately separate from (and additional to) the org-wide
// aiPolicy.voiceEnabled gate (src/lib/industry-config.js) -- both must be
// true before the guide ever speaks. Follows the exact {orgId, email}
// keyed, unique-indexed, upsert-on-write pattern already established by
// notification_prefs (src/lib/notify/router.js) rather than inventing a
// new storage shape.

import { getOrgCollections, toObjectId } from "../orgs.js";

let indexed = false;
async function col() {
  const { db } = await getOrgCollections();
  const prefs = db.collection("guide_prefs");
  if (!indexed) {
    await prefs.createIndex({ orgId: 1, email: 1 }, { unique: true });
    indexed = true;
  }
  return prefs;
}

const norm = (e) => String(e || "").trim().toLowerCase();

export async function getGuidePrefs({ orgId, email }) {
  const prefs = await col();
  const row = await prefs.findOne({ orgId: toObjectId(orgId), email: norm(email) });
  return { readHintsAloud: !!row?.readHintsAloud };
}

export async function setGuidePrefs({ orgId, email, readHintsAloud }) {
  const prefs = await col();
  await prefs.updateOne(
    { orgId: toObjectId(orgId), email: norm(email) },
    { $set: { readHintsAloud: !!readHintsAloud } },
    { upsert: true }
  );
  return getGuidePrefs({ orgId, email });
}
