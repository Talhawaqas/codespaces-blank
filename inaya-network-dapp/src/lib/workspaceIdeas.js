// src/lib/workspaceIdeas.js -- "Suggest an improvement" (post-SOW #6, owner-approved 23 Nov 2026).
// Business Workspace customers send ideas to INAYA (not to their own customer portal). Stored in the dApp's existing
// feedback_submissions collection (source "business") so the admin dashboard triages both together -- no new collection.
//
// Privacy: another company only ever sees an idea's TITLE and status, and only once Inaya has put it on the public board
// (publicBoard: true, or status Reviewing / Planned / In Progress / Shipped). A company sees its own ideas in full.
// Voting (+1) merges duplicates: one vote per person per idea. When Inaya moves an idea to Planned or Shipped, everyone who
// submitted or voted gets an in-app notification (see notifyIdeaStatus, called by the admin PATCH route).
import { ObjectId } from "mongodb";
import { getFeedbackCollections, ensureFeedbackIndexes } from "./feedback.js";

export const IMPORTANCE = ["Nice to have", "Important", "Critical for us"];
export const BOARD_STATUSES = ["Reviewing", "Planned", "In Progress", "Shipped"];
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
const oid = (x) => { try { return new ObjectId(String(x)); } catch { return null; } };
const fail = (error, status = 400) => ({ error, status });
const onBoard = (d) => d.publicBoard === true || BOARD_STATUSES.includes(d.status);

export async function submitIdea({ orgId, orgName, email, input = {} }) {
  const title = clean(input.title, 200); const problem = clean(input.problem, 3000);
  if (title.length < 5) return fail("Give the idea a short title.");
  if (problem.length < 10) return fail("Describe the problem it would solve.");
  const importance = IMPORTANCE.includes(input.importance) ? input.importance : "Important";
  await ensureFeedbackIndexes(); const { feedback } = await getFeedbackCollections();
  const since = new Date(Date.now() - 86400000);
  if ((await feedback.countDocuments({ source: "business", orgId: String(orgId), createdAt: { $gte: since } })) >= 20) return fail("Your company has sent 20 ideas today. Please try again tomorrow.", 429);
  const now = new Date(); const me = String(email).toLowerCase();
  const doc = { type: "idea", source: "business", category: "Business Workspace", title, description: problem, importance, orgId: String(orgId), orgName: clean(orgName, 120) || null, submitterEmail: me,
    voters: [{ orgId: String(orgId), email: me }], voteCount: 1, status: "New", sprint: null, publicBoard: false, adminNotes: "", createdAt: now, updatedAt: now };
  const r = await feedback.insertOne(doc);
  return { idea: view({ ...doc, _id: r.insertedId }, orgId, me) };
}

function view(d, orgId, me) {
  const mine = d.orgId === String(orgId);
  return { id: String(d._id), title: d.title, status: d.status, sprint: d.sprint || null, votes: d.voteCount || 0, votedByMe: (d.voters || []).some((v) => v.email === me),
    mine, ...(mine ? { problem: d.description, importance: d.importance, submittedBy: d.submitterEmail, note: d.status === "Rejected" ? d.adminNotes || null : null } : {}), createdAt: d.createdAt };
}

export async function listIdeas({ orgId, email }) {
  await ensureFeedbackIndexes(); const { feedback } = await getFeedbackCollections(); const me = String(email).toLowerCase();
  const rows = await feedback.find({ source: "business", type: "idea", $or: [{ orgId: String(orgId) }, { publicBoard: true }, { status: { $in: BOARD_STATUSES } }] }).sort({ voteCount: -1, createdAt: -1 }).limit(300).toArray();
  return { mine: rows.filter((d) => d.orgId === String(orgId)).map((d) => view(d, orgId, me)), board: rows.filter((d) => onBoard(d)).map((d) => view(d, orgId, me)) };
}

/** +1 (or remove your +1). Only on your own company's ideas or ideas on the public board. */
export async function voteIdea({ orgId, email, id, on = true }) {
  const _id = oid(id); if (!_id) return fail("Idea not found.", 404);
  const { feedback } = await getFeedbackCollections(); const me = String(email).toLowerCase();
  const d = await feedback.findOne({ _id, source: "business", type: "idea" }); if (!d || !(d.orgId === String(orgId) || onBoard(d))) return fail("Idea not found.", 404);
  if (on) await feedback.updateOne({ _id, "voters.email": { $ne: me } }, { $push: { voters: { orgId: String(orgId), email: me } }, $inc: { voteCount: 1 }, $set: { updatedAt: new Date() } });
  else await feedback.updateOne({ _id, "voters.email": me }, { $pull: { voters: { email: me } }, $inc: { voteCount: -1 }, $set: { updatedAt: new Date() } });
  const after = await feedback.findOne({ _id }); return { idea: view(after, orgId, me) };
}

/** Called by the admin PATCH route after a status change: tells the submitter and every voter (one notification each). */
export async function notifyIdeaStatus(doc) {
  if (doc?.source !== "business" || !["Planned", "Shipped"].includes(doc.status)) return 0;
  const { createNotification } = await import("./notifications.js"); let n = 0;
  for (const v of doc.voters || []) {
    try {
      await createNotification({ scope: "org", orgId: v.orgId, targetEmail: v.email, category: "system", type: "idea_status", severity: "info",
        title: doc.status === "Planned" ? `Planned: "${doc.title}"` : `Shipped: "${doc.title}"`,
        body: doc.status === "Planned" ? `Inaya has planned your suggestion${doc.sprint ? ` for ${doc.sprint}` : ""}. Thank you!` : "Your suggestion is now live in Inaya. Thank you!",
        sourceModule: "ideas", sourceId: String(doc._id), actionUrl: "/business?view=ideas", dedupeKey: `idea:${doc._id}:${doc.status}:${v.email}` });
      n++;
    } catch { /* one failed notification never blocks the rest */ }
  }
  return n;
}
