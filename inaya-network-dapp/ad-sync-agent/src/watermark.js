// ad-sync-agent/src/watermark.js
//
// Persists the last synced highestCommittedUSN to a local file, so a
// restart resumes an incremental sync instead of re-pulling and
// re-signaling every user in the directory. Deliberately local disk, not
// a database -- this agent has no infrastructure of its own beyond
// what's needed to run on a machine inside the customer's network.

import fs from "node:fs";

export function readWatermark(path) {
  try {
    const raw = fs.readFileSync(path, "utf8");
    const n = Number(JSON.parse(raw).highestCommittedUSN);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined; // no watermark yet -- first run does a full pull
  }
}

export function writeWatermark(path, highestCommittedUSN) {
  fs.writeFileSync(path, JSON.stringify({ highestCommittedUSN, savedAt: new Date().toISOString() }, null, 2));
}
