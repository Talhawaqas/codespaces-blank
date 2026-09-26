// src/lib/support/ideas.js
//
// SOW §19: "Submit an Idea". A customer's product suggestion with a real lifecycle
//   SUBMITTED -> UNDER_REVIEW -> PLANNED -> IN_PROGRESS -> SHIPPED, or DECLINED / DUPLICATE.
// Submitting an idea promises nothing. Ideas can contain confidential information, so:
//   - an idea is PRIVATE to its submitter and the organization's staff by default;
//   - community visibility and voting are OPT-IN (the submitter chooses, and the organization must enable voting),
//     and a community view never carries the submitter, their company or their attachments;
//   - duplicate detection (deterministic text similarity) is offered BEFORE submission and never auto-merges.

import { toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, toPlainText, IDEA_STATES, similarity, sha256, newToken } from "./common.js";
import { audit, emit } from "./record.js";
import { notifyStaff, notifyCustomer, portalUrl, emailBody } from "./notify.js";
import { screenFile, safeFilename, storeSupportObject, BUCKET } from "./attachments.js";
import { getS3ObjectBody } from "../s3-compat/store.js";

const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

async function nextIdeaNumber(orgId) {
  const { supportCounters } = await getSupportCollections();
  const r = await supportCounters.findOneAndUpdate({ _id: `idea:${orgId}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return `IDEA-${100 + r.seq}`;
}

const own = (i) => ({ id: String(i._id), number: i.number, title: i.title, description: i.description, category: i.category, expectedBenefit: i.expectedBenefit || "", module: i.module || null, status: i.status, publicNote: i.publicNote || null, communityVisible: !!i.communityVisible, votes: i.votes?.length || 0, duplicateOf: i.duplicateOfNumber || null, attachments: (i.attachments || []).map((a) => ({ id: a.id, filename: a.filename, sizeBytes: a.sizeBytes })), createdAt: i.createdAt, updatedAt: i.updatedAt, history: (i.history || []).filter((h) => h.customerVisible).map((h) => ({ at: h.at, status: h.status, note: h.note || null })) });
const community = (i, me) => ({ id: String(i._id), number: i.number, title: i.title, description: i.description, category: i.category, module: i.module || null, status: i.status, votes: i.votes?.length || 0, voted: (i.votes || []).some((v) => String(v) === String(me)) });

/** Similar existing ideas the submitter may be shown: their own, and community-visible ones (public fields only). */
export async function checkDuplicates({ orgId, user, title, description, limit = 5 }) {
  const { supportIdeas } = await getSupportCollections();
  const rows = await supportIdeas.find({ orgId: toObjectId(orgId), status: { $nin: ["DECLINED"] }, $or: [{ "submitter.portalUserId": user._id }, { communityVisible: true }] }).sort({ createdAt: -1 }).limit(300).toArray();
  const text = `${title} ${description}`;
  return rows.map((i) => ({ i, score: similarity(text, `${i.title} ${i.description}`) })).filter((x) => x.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, limit).map(({ i, score }) => ({ ...(String(i.submitter?.portalUserId) === String(user._id) ? own(i) : community(i, user._id)), mine: String(i.submitter?.portalUserId) === String(user._id), similarity: Math.round(score * 100) / 100 }));
}

export async function submitIdea({ orgId, settings, user, body }) {
  await ensureSupportIndexes();
  if (!settings.ideas.enabled) return fail("Ideas are not enabled.", 403);
  const b = body || {};
  const title = toPlainText(b.title, 160); const description = toPlainText(b.description, 8000);
  if (title.length < 4) return fail("A title of at least 4 characters is required.");
  if (description.length < 10) return fail("Please describe your idea (at least 10 characters).");
  const { supportIdeas } = await getSupportCollections();
  if (b.associateWithId) {
    const target = await supportIdeas.findOne({ _id: oidOf(b.associateWithId) || undefined, orgId: toObjectId(orgId), $or: [{ communityVisible: true }, { "submitter.portalUserId": user._id }] });
    if (!target) return fail("That idea could not be found.", 404);
    if (!settings.ideas.votingEnabled && String(target.submitter?.portalUserId) !== String(user._id)) return fail("Voting is not enabled.", 403);
    await supportIdeas.updateOne({ _id: target._id }, { $addToSet: { votes: user._id, associated: user._id } });
    return { associated: true, idea: (String(target.submitter?.portalUserId) === String(user._id) ? own : (i) => community(i, user._id))(await supportIdeas.findOne({ _id: target._id })) };
  }
  const doc = { orgId: toObjectId(orgId), number: await nextIdeaNumber(orgId), title, description, category: String(b.category || "General").slice(0, 60), expectedBenefit: toPlainText(b.expectedBenefit, 1000), module: b.module ? String(b.module).slice(0, 60) : null, status: "SUBMITTED", communityVisible: b.communityVisible === true && settings.ideas.votingEnabled, submitter: { portalUserId: user._id, email: user.email, name: user.name || null }, votes: [], attachments: [], history: [{ at: nowIso(), status: "SUBMITTED", by: user.email, customerVisible: true }], createdAt: nowIso(), updatedAt: nowIso() };
  doc._id = (await supportIdeas.insertOne(doc)).insertedId;
  await audit({ orgId, action: "IDEA_CREATED", actorEmail: user.email, metadata: { number: doc.number, communityVisible: doc.communityVisible } });
  await emit({ orgId, type: "idea.created", data: { number: doc.number, title }, actor: user.email });
  await notifyStaff({ orgId, emails: null, title: `New idea ${doc.number}: ${title}`, body: description.slice(0, 200), dedupeKey: `support:idea:${doc._id}` });
  return { idea: own(doc) };
}

export async function addIdeaAttachment({ orgId, settings, user, ideaId, file }) {
  const { supportIdeas } = await getSupportCollections();
  const idea = await supportIdeas.findOne({ _id: oidOf(ideaId) || undefined, orgId: toObjectId(orgId), "submitter.portalUserId": user._id });
  if (!idea) return fail("Idea not found.", 404);
  if ((idea.attachments || []).length >= 3) return fail("At most 3 attachments per idea.");
  const filename = safeFilename(file.filename); const screened = await screenFile({ filename, buffer: file.buffer, settings });
  if (screened.error) return fail(screened.error, screened.reasonCode === "SCAN_UNAVAILABLE" ? 503 : 400, { reasonCode: screened.reasonCode });
  const attId = newToken(9);
  const key = `ideas/${idea._id}/${attId}/${filename}`;
  let obj; try { obj = await storeSupportObject({ orgId, key, buffer: file.buffer, contentType: "application/octet-stream", actorEmail: user.email }); } catch { return fail("The file could not be stored right now.", 502); }
  await supportIdeas.updateOne({ _id: idea._id }, { $push: { attachments: { id: attId, filename, sizeBytes: file.buffer.length, sha256: sha256(file.buffer), key, versionId: obj?.versionId || null } } });
  return { attachment: { id: attId, filename, sizeBytes: file.buffer.length } };
}

export async function getIdeaAttachment({ orgId, ideaId, attachmentId, viewer }) {
  const { supportIdeas } = await getSupportCollections();
  const idea = await supportIdeas.findOne({ _id: oidOf(ideaId) || undefined, orgId: toObjectId(orgId) });
  if (!idea) return null;
  if (viewer.kind === "customer" && String(idea.submitter?.portalUserId) !== String(viewer.user._id)) return null; // attachments are never part of the community view
  const a = (idea.attachments || []).find((x) => x.id === String(attachmentId));
  if (!a) return null;
  const obj = await getS3ObjectBody({ orgId: String(orgId), bucket: BUCKET, key: a.key, versionId: a.versionId || undefined });
  return obj ? { filename: a.filename, buffer: obj.buffer } : null;
}

export async function listIdeasForCustomer({ orgId, settings, user, scope = "mine" }) {
  const { supportIdeas } = await getSupportCollections();
  if (scope === "community") {
    if (!settings.ideas.votingEnabled) return { ideas: [] };
    return { ideas: (await supportIdeas.find({ orgId: toObjectId(orgId), communityVisible: true, status: { $nin: ["DECLINED", "DUPLICATE"] } }).sort({ createdAt: -1 }).limit(100).toArray()).map((i) => community(i, user._id)) };
  }
  const rows = await supportIdeas.find({ orgId: toObjectId(orgId), "submitter.portalUserId": user._id }).sort({ createdAt: -1 }).limit(100).toArray();
  return { ideas: rows.map(own), summary: { submitted: rows.length, planned: rows.filter((i) => ["PLANNED", "IN_PROGRESS"].includes(i.status)).length, shipped: rows.filter((i) => i.status === "SHIPPED").length } };
}

export async function voteIdea({ orgId, settings, user, ideaId, on = true }) {
  if (!settings.ideas.votingEnabled) return fail("Voting is not enabled.", 403);
  const { supportIdeas } = await getSupportCollections();
  const idea = await supportIdeas.findOne({ _id: oidOf(ideaId) || undefined, orgId: toObjectId(orgId), communityVisible: true });
  if (!idea) return fail("Idea not found.", 404);
  if (String(idea.submitter?.portalUserId) === String(user._id)) return fail("You cannot vote on your own idea.");
  await supportIdeas.updateOne({ _id: idea._id }, on ? { $addToSet: { votes: user._id } } : { $pull: { votes: user._id } });
  return { idea: community(await supportIdeas.findOne({ _id: idea._id }), user._id) };
}

// -------------------------------------------------------------------------------- agents
export async function listIdeas({ orgId, status = null }) {
  const { supportIdeas } = await getSupportCollections();
  const f = { orgId: toObjectId(orgId) }; if (status) f.status = status;
  return { ideas: (await supportIdeas.find(f).sort({ createdAt: -1 }).limit(200).toArray()).map((i) => ({ ...own(i), submitter: { email: i.submitter?.email, name: i.submitter?.name }, history: i.history })) };
}

export async function updateIdeaStatus({ orgId, settings, ideaId, status, publicNote = null, duplicateOfId = null, actor }) {
  if (!IDEA_STATES.includes(status)) return fail(`status must be one of ${IDEA_STATES.join(", ")}.`);
  const { supportIdeas } = await getSupportCollections();
  const idea = await supportIdeas.findOne({ _id: oidOf(ideaId) || undefined, orgId: toObjectId(orgId) });
  if (!idea) return fail("Idea not found.", 404);
  const set = { status, updatedAt: nowIso() };
  if (publicNote !== null) set.publicNote = toPlainText(publicNote, 500);
  if (status === "DUPLICATE") {
    const dup = await supportIdeas.findOne({ _id: oidOf(duplicateOfId) || undefined, orgId: toObjectId(orgId) });
    if (!dup || String(dup._id) === String(idea._id)) return fail("Choose the idea this duplicates.");
    set.duplicateOf = dup._id; set.duplicateOfNumber = dup.number;
    await supportIdeas.updateOne({ _id: dup._id }, { $addToSet: { votes: idea.submitter.portalUserId } });
  }
  await supportIdeas.updateOne({ _id: idea._id }, { $set: set, $push: { history: { at: nowIso(), status, by: actor.email, note: set.publicNote || null, customerVisible: true } } });
  await audit({ orgId, action: "IDEA_STATUS_CHANGED", actorEmail: actor.email, previousState: idea.status, newState: status, metadata: { number: idea.number } });
  await emit({ orgId, type: "idea.status_changed", data: { number: idea.number, from: idea.status, to: status }, actor: actor.email });
  await notifyCustomer({ orgId, settings, to: { email: idea.submitter.email, portalUserId: idea.submitter.portalUserId }, type: "idea_status", title: `Your idea ${idea.number} is now ${status.replace(/_/g, " ").toLowerCase()}`, body: set.publicNote || idea.title, dedupeKey: `support:idea:${idea._id}:${status}:${set.updatedAt}`, email: settings.portalSlug ? { subject: `Update on your idea ${idea.number}`, ...emailBody({ heading: `Your idea ${idea.number} is now ${status.replace(/_/g, " ").toLowerCase()}`, message: `${idea.title}\n\n${set.publicNote || ""}`.trim(), linkUrl: portalUrl(settings, "?view=ideas"), linkLabel: "View your ideas" }) } : null });
  return { idea: own(await supportIdeas.findOne({ _id: idea._id })) };
}
