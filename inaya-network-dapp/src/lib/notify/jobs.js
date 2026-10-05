// src/lib/notify/jobs.js -- scheduled notification jobs. notifyExpiringShares: tell the creator of a share link that it expires within the window, once.
import { getOrgCollections } from "../orgs.js";
import { notifyEvent } from "./router.js";
export async function notifyExpiringShares({ withinHours = 48, now = Date.now(), limit = 200 } = {}) {
  const { documentShares } = await getOrgCollections(); const until = new Date(now + withinHours * 3600_000).toISOString(); const nowIso = new Date(now).toISOString(); let sent = 0;
  const rows = await documentShares.find({ revokedAt: null, expiresAt: { $gt: nowIso, $lte: until }, expiryNotifiedAt: { $exists: false }, createdByEmail: { $exists: true } }).limit(limit).toArray();
  for (const s of rows) {
    const r = await documentShares.updateOne({ _id: s._id, expiryNotifiedAt: { $exists: false } }, { $set: { expiryNotifiedAt: nowIso } }); if (!r.modifiedCount) continue;
    await notifyEvent({ orgId: s.orgId, event: "share.expiring", targetEmail: s.createdByEmail, title: "A share link is about to expire", body: `A link you created expires ${new Date(s.expiresAt).toUTCString()}.`, link: "/business?view=shares", sourceId: String(s._id), dedupeKey: `share-exp:${s._id}`, protectedContent: true }).catch(() => {}); sent++;
  }
  return { sent };
}
