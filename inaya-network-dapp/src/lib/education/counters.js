// src/lib/education/counters.js
//
// Gap-free sequential numbers per school (admission numbers, fee receipts),
// issued with one atomic $inc so two clerks saving at once never get the
// same number.

import { getOrgCollections } from "../orgs.js";

export async function nextNumber(orgId, series) {
  const { eduCounters } = await getOrgCollections();
  const row = await eduCounters.findOneAndUpdate(
    { _id: `${orgId}:${series}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return row.seq;
}
