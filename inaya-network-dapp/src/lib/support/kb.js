// src/lib/support/kb.js
//
// SOW §18, §46, §47: the Knowledge Base. Per-organization articles with a real review workflow and versions:
//
//   DRAFT -> IN_REVIEW -> PUBLISHED -> ARCHIVED
//
// An article has immutable-once-published versions. The LIVE version is what customers see and what search indexes;
// editing a published article starts a new draft version and leaves the live one untouched until a person
// publishes the new one. Publishing needs the manage_kb permission, and the author cannot approve their own
// article unless they are an organization owner/admin. AI may PROPOSE a draft (ai.js); a human publishes.
// Audience: PUBLIC (anyone), CUSTOMERS (signed-in portal users), INTERNAL (agents only).
// Search uses the MongoDB text index over the live content; customer search only ever reaches the audiences
// that customer may read.

import { toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, nowIso, toPlainText, KB_AUDIENCES, similarity, tokens } from "./common.js";
import { audit, emit, track } from "./record.js";
import { notifyStaff } from "./notify.js";

const slugify = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "article";
const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

function articleView(a, v = null) {
  return { id: String(a._id), slug: a.slug, title: a.title, summary: a.summary, category: a.category, module: a.module || null, audience: a.audience, tags: a.tags || [], status: a.status, liveVersion: a.liveVersion || null, latestVersion: a.latestVersion, updatedAt: a.updatedAt, publishedAt: a.publishedAt || null, lastReviewedAt: a.lastReviewedAt || null, helpful: a.counters?.helpful || 0, notHelpful: a.counters?.notHelpful || 0, views: a.counters?.views || 0, aiDrafted: !!a.aiDrafted, ...(v ? { body: v.body, version: v.version, author: v.authorEmail, reviewer: v.reviewerEmail || null } : {}) };
}

export async function createArticle({ orgId, actor, body, aiDrafted = false }) {
  await ensureSupportIndexes();
  const b = body || {};
  const title = toPlainText(b.title, 160); const text = toPlainText(b.body, 40000);
  if (title.length < 3) return fail("A title of at least 3 characters is required.");
  if (!text) return fail("The article body is required.");
  const audience = b.audience || "CUSTOMERS";
  if (!KB_AUDIENCES.includes(audience)) return fail(`audience must be one of ${KB_AUDIENCES.join(", ")}.`);
  const { supportKbArticles, supportKbVersions } = await getSupportCollections();
  let slug = slugify(title);
  for (let i = 0; i < 20; i++) { if (!(await supportKbArticles.findOne({ orgId: toObjectId(orgId), slug: i ? `${slug}-${i + 1}` : slug }, { projection: { _id: 1 } }))) { slug = i ? `${slug}-${i + 1}` : slug; break; } }
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), slug, title, summary: toPlainText(b.summary || text.slice(0, 200), 300), body: text, category: String(b.category || "General").slice(0, 60), module: b.module ? String(b.module).slice(0, 60) : null, audience, collectionId: b.collectionId ? String(b.collectionId).slice(0, 60) : null, tags: (Array.isArray(b.tags) ? b.tags : []).slice(0, 20).map((t) => String(t).slice(0, 30)), status: "DRAFT", liveVersion: null, latestVersion: 1, createdAt: now, updatedAt: now, counters: { views: 0, helpful: 0, notHelpful: 0 }, aiDrafted, authorEmail: actor.email };
  const r = await supportKbArticles.insertOne(doc);
  await supportKbVersions.insertOne({ orgId: doc.orgId, articleId: r.insertedId, version: 1, title, body: text, summary: doc.summary, tags: doc.tags, status: "DRAFT", authorEmail: actor.email, createdAt: now });
  await audit({ orgId, action: "KB_ARTICLE_CREATED", actorEmail: actor.email, metadata: { slug, aiDrafted } });
  return { article: articleView({ ...doc, _id: r.insertedId }, { body: text, version: 1, authorEmail: actor.email }) };
}

export async function editArticle({ orgId, articleId, actor, body }) {
  const { supportKbArticles, supportKbVersions } = await getSupportCollections();
  const a = await supportKbArticles.findOne({ _id: oidOf(articleId) || undefined, orgId: toObjectId(orgId) });
  if (!a) return fail("Article not found.", 404);
  if (a.status === "ARCHIVED") return fail("An archived article must be restored before it can be edited.", 409);
  const b = body || {};
  const latest = await supportKbVersions.findOne({ orgId: a.orgId, articleId: a._id, version: a.latestVersion });
  const next = { title: b.title !== undefined ? toPlainText(b.title, 160) : latest.title, body: b.body !== undefined ? toPlainText(b.body, 40000) : latest.body, summary: b.summary !== undefined ? toPlainText(b.summary, 300) : latest.summary, tags: b.tags !== undefined ? (Array.isArray(b.tags) ? b.tags.slice(0, 20).map((t) => String(t).slice(0, 30)) : latest.tags) : latest.tags };
  if (next.title.length < 3 || !next.body) return fail("A title and a body are required.");
  const meta = {};
  if (b.category !== undefined) meta.category = String(b.category).slice(0, 60);
  if (b.module !== undefined) meta.module = b.module ? String(b.module).slice(0, 60) : null;
  if (b.audience !== undefined) { if (!KB_AUDIENCES.includes(b.audience)) return fail(`audience must be one of ${KB_AUDIENCES.join(", ")}.`); meta.audience = b.audience; }
  let version = a.latestVersion;
  if (latest.status === "PUBLISHED" || latest.status === "SUPERSEDED") {
    version = a.latestVersion + 1; // published content is never edited in place
    await supportKbVersions.insertOne({ orgId: a.orgId, articleId: a._id, version, ...next, status: "DRAFT", authorEmail: actor.email, createdAt: nowIso() });
    await supportKbArticles.updateOne({ _id: a._id }, { $set: { latestVersion: version, updatedAt: nowIso(), ...meta } });
  } else {
    await supportKbVersions.updateOne({ _id: latest._id }, { $set: { ...next, status: "DRAFT", authorEmail: latest.authorEmail || actor.email, editedBy: actor.email, editedAt: nowIso() } });
    await supportKbArticles.updateOne({ _id: a._id }, { $set: { status: a.liveVersion ? a.status : "DRAFT", updatedAt: nowIso(), ...meta, ...(a.liveVersion ? {} : { title: next.title, body: next.body, summary: next.summary, tags: next.tags }) } });
  }
  await audit({ orgId, action: "KB_ARTICLE_EDITED", actorEmail: actor.email, metadata: { slug: a.slug, version } });
  return { article: articleView(await supportKbArticles.findOne({ _id: a._id }), await supportKbVersions.findOne({ articleId: a._id, version })) };
}

export async function submitForReview({ orgId, articleId, actor }) {
  const { supportKbArticles, supportKbVersions } = await getSupportCollections();
  const a = await supportKbArticles.findOne({ _id: oidOf(articleId) || undefined, orgId: toObjectId(orgId) });
  if (!a) return fail("Article not found.", 404);
  const r = await supportKbVersions.findOneAndUpdate({ orgId: a.orgId, articleId: a._id, version: a.latestVersion, status: "DRAFT" }, { $set: { status: "IN_REVIEW", submittedBy: actor.email, submittedAt: nowIso() } }, { returnDocument: "after" });
  if (!r) return fail("Only a draft can be submitted for review.", 409);
  if (!a.liveVersion) await supportKbArticles.updateOne({ _id: a._id }, { $set: { status: "IN_REVIEW", updatedAt: nowIso() } });
  await audit({ orgId, action: "KB_ARTICLE_SUBMITTED", actorEmail: actor.email, metadata: { slug: a.slug, version: a.latestVersion } });
  await notifyStaff({ orgId, emails: null, title: `Article ready for review: ${a.title}`, body: "A knowledge base article is waiting for review.", dedupeKey: `support:kbreview:${a._id}:${a.latestVersion}` });
  return { ok: true };
}

export async function reviewArticle({ orgId, articleId, actor, membership, decision, note }) {
  const { supportKbArticles, supportKbVersions } = await getSupportCollections();
  const a = await supportKbArticles.findOne({ _id: oidOf(articleId) || undefined, orgId: toObjectId(orgId) });
  if (!a) return fail("Article not found.", 404);
  const v = await supportKbVersions.findOne({ orgId: a.orgId, articleId: a._id, version: a.latestVersion });
  if (v.status !== "IN_REVIEW" && v.status !== "DRAFT") return fail("There is nothing to review.", 409);
  if (decision === "reject") { await supportKbVersions.updateOne({ _id: v._id }, { $set: { status: "DRAFT", reviewNote: String(note || "").slice(0, 500), reviewerEmail: actor.email, reviewedAt: nowIso() } }); await audit({ orgId, action: "KB_ARTICLE_REVIEW_REJECTED", actorEmail: actor.email, metadata: { slug: a.slug } }); return { ok: true, status: "DRAFT" }; }
  if (decision !== "approve") return fail("decision must be approve or reject.");
  if (v.authorEmail === actor.email && !canManageOrg(membership)) return fail("The author cannot approve their own article. Ask another reviewer (an organization owner or admin may publish their own).", 403, { reasonCode: "SELF_APPROVAL" });
  const now = nowIso();
  if (a.liveVersion && a.liveVersion !== v.version) await supportKbVersions.updateOne({ orgId: a.orgId, articleId: a._id, version: a.liveVersion }, { $set: { status: "SUPERSEDED" } });
  await supportKbVersions.updateOne({ _id: v._id }, { $set: { status: "PUBLISHED", reviewerEmail: actor.email, reviewedAt: now, publishedAt: now } });
  await supportKbArticles.updateOne({ _id: a._id }, { $set: { status: "PUBLISHED", liveVersion: v.version, title: v.title, body: v.body, summary: v.summary, tags: v.tags, publishedAt: now, lastReviewedAt: now, updatedAt: now } });
  await audit({ orgId, action: "KB_ARTICLE_PUBLISHED", actorEmail: actor.email, metadata: { slug: a.slug, version: v.version } });
  await emit({ orgId, type: "knowledge_article.published", data: { slug: a.slug, title: v.title, version: v.version }, actor: actor.email });
  return { ok: true, status: "PUBLISHED", version: v.version };
}

export async function archiveArticle({ orgId, articleId, actor, restore = false }) {
  const { supportKbArticles } = await getSupportCollections();
  const a = await supportKbArticles.findOne({ _id: oidOf(articleId) || undefined, orgId: toObjectId(orgId) });
  if (!a) return fail("Article not found.", 404);
  await supportKbArticles.updateOne({ _id: a._id }, { $set: { status: restore ? (a.liveVersion ? "PUBLISHED" : "DRAFT") : "ARCHIVED", archivedAt: restore ? null : nowIso(), updatedAt: nowIso() } });
  await audit({ orgId, action: restore ? "KB_ARTICLE_RESTORED" : "KB_ARTICLE_ARCHIVED", actorEmail: actor.email, metadata: { slug: a.slug } });
  return { ok: true };
}

export async function listArticlesForAgents({ orgId, status = null, q = null }) {
  const { supportKbArticles } = await getSupportCollections();
  const f = { orgId: toObjectId(orgId) };
  if (status) f.status = status;
  if (q) f.title = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return { articles: (await supportKbArticles.find(f).sort({ updatedAt: -1 }).limit(200).toArray()).map((a) => articleView(a)) };
}
export async function getArticleForAgents({ orgId, articleId }) {
  const { supportKbArticles, supportKbVersions } = await getSupportCollections();
  const a = await supportKbArticles.findOne({ _id: oidOf(articleId) || undefined, orgId: toObjectId(orgId) });
  if (!a) return fail("Article not found.", 404);
  const versions = await supportKbVersions.find({ orgId: a.orgId, articleId: a._id }).sort({ version: -1 }).toArray();
  return { article: articleView(a, versions[0]), versions: versions.map((v) => ({ version: v.version, status: v.status, author: v.authorEmail, reviewer: v.reviewerEmail || null, createdAt: v.createdAt, publishedAt: v.publishedAt || null, title: v.title, body: v.body })) };
}

// ------------------------------------------------------------------------ customer side
const allowedAudiences = (level) => (level === "INTERNAL" ? KB_AUDIENCES : level === "CUSTOMERS" ? ["PUBLIC", "CUSTOMERS"] : ["PUBLIC"]);

/** Searches PUBLISHED articles the reader may see. level = PUBLIC | CUSTOMERS | INTERNAL. */
export async function searchArticles({ orgId, q, level = "PUBLIC", limit = 8, actor = null, track: doTrack = true }) {
  const { supportKbArticles } = await getSupportCollections();
  const term = String(q || "").trim().slice(0, 120);
  const base = { orgId: toObjectId(orgId), status: "PUBLISHED", liveVersion: { $ne: null }, audience: { $in: allowedAudiences(level) } };
  let rows = [];
  if (term) {
    try { rows = await supportKbArticles.find({ ...base, $text: { $search: term } }, { projection: { score: { $meta: "textScore" } } }).sort({ score: { $meta: "textScore" } }).limit(limit).toArray(); } catch { rows = []; }
    if (!rows.length) { const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); rows = await supportKbArticles.find({ ...base, $or: [{ title: re }, { tags: re }, { summary: re }] }).limit(limit).toArray(); }
  } else rows = await supportKbArticles.find(base).sort({ "counters.views": -1 }).limit(limit).toArray();
  const results = rows.map((a) => ({ id: String(a._id), slug: a.slug, title: a.title, summary: a.summary, category: a.category, snippet: snippet(a.body, term), helpful: a.counters?.helpful || 0 }));
  if (doTrack && term) await track({ orgId, type: "kb.searched", actor: actor?.email || null, data: { q: term.slice(0, 80), results: results.length, userId: actor?.id || null } });
  return { results };
}
function snippet(body, term) {
  const text = String(body || ""); if (!term) return text.slice(0, 180);
  const w = [...tokens(term)][0]; const i = w ? text.toLowerCase().indexOf(w) : -1;
  return (i > 60 ? "…" : "") + text.slice(Math.max(0, i - 60), Math.max(0, i - 60) + 220).trim() + "…";
}

export async function listCategories({ orgId, level = "PUBLIC" }) {
  const { supportKbArticles } = await getSupportCollections();
  const rows = await supportKbArticles.aggregate([{ $match: { orgId: toObjectId(orgId), status: "PUBLISHED", audience: { $in: allowedAudiences(level) } } }, { $group: { _id: "$category", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
  return { categories: rows.map((r) => ({ name: r._id, count: r.count })) };
}

export async function getArticle({ orgId, slug, level = "PUBLIC", actor = null }) {
  const { supportKbArticles } = await getSupportCollections();
  const a = await supportKbArticles.findOneAndUpdate({ orgId: toObjectId(orgId), slug: String(slug), status: "PUBLISHED", audience: { $in: allowedAudiences(level) } }, { $inc: { "counters.views": 1 } }, { returnDocument: "after" });
  if (!a) return null;
  await track({ orgId, type: "kb.viewed", actor: actor?.email || null, data: { slug: a.slug, userId: actor?.id || null } });
  return { id: String(a._id), slug: a.slug, title: a.title, summary: a.summary, body: a.body, category: a.category, module: a.module || null, tags: a.tags || [], updatedAt: a.publishedAt || a.updatedAt, version: a.liveVersion };
}

/** Helpful / not helpful, or a problem report (which reaches the KB managers). */
export async function submitFeedback({ orgId, slug, level, user, helpful = null, kind = "helpful", comment = "" }) {
  const { supportKbArticles, supportKbFeedback } = await getSupportCollections();
  const a = await supportKbArticles.findOne({ orgId: toObjectId(orgId), slug: String(slug), status: "PUBLISHED", audience: { $in: allowedAudiences(level) } });
  if (!a) return fail("Article not found.", 404);
  if (!["helpful", "problem"].includes(kind)) return fail("kind must be helpful or problem.");
  const doc = { orgId: a.orgId, articleId: a._id, slug: a.slug, kind, helpful: kind === "helpful" ? !!helpful : null, comment: toPlainText(comment, 1000), userId: user?._id || null, email: user?.email || null, createdAt: nowIso() };
  await supportKbFeedback.insertOne(doc);
  if (kind === "helpful") await supportKbArticles.updateOne({ _id: a._id }, { $inc: { [helpful ? "counters.helpful" : "counters.notHelpful"]: 1 } });
  else await notifyStaff({ orgId, emails: null, title: `Article problem reported: ${a.title}`, body: doc.comment || "A customer reported a problem with an article.", dedupeKey: `support:kbproblem:${a._id}:${user?._id || "anon"}:${Date.now()}`, severity: "warning" });
  await track({ orgId, type: kind === "helpful" ? "kb.rated" : "kb.problem", actor: user?.email || null, data: { slug: a.slug, helpful: doc.helpful, userId: user?._id ? String(user._id) : null } });
  return { recorded: true };
}

// ----------------------------------------------------------------------------- gaps (SOW §18.5)
/** Repeated questions with no matching published article: the raw material for a new article. */
export async function detectGaps({ orgId, days = 30, minTickets = 3 }) {
  const { supportTickets, supportKbArticles } = await getSupportCollections();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const tickets = await supportTickets.find({ orgId: toObjectId(orgId), createdAt: { $gte: since }, deletedAt: null }).sort({ createdAt: -1 }).limit(500).project({ number: 1, subject: 1, description: 1 }).toArray();
  const clusters = [];
  for (const t of tickets) {
    const text = `${t.subject} ${String(t.description).slice(0, 300)}`;
    const c = clusters.find((cl) => similarity(cl.text, text) >= 0.35);
    if (c) c.tickets.push(t); else clusters.push({ text, subject: t.subject, tickets: [t] });
  }
  const articles = await supportKbArticles.find({ orgId: toObjectId(orgId), status: "PUBLISHED" }).project({ title: 1, summary: 1, tags: 1 }).toArray();
  const gaps = [];
  for (const c of clusters.filter((c) => c.tickets.length >= minTickets)) {
    const best = Math.max(0, ...articles.map((a) => similarity(c.text, `${a.title} ${a.summary} ${(a.tags || []).join(" ")}`)));
    if (best < 0.25) gaps.push({ topic: c.subject, ticketCount: c.tickets.length, sampleTickets: c.tickets.slice(0, 5).map((t) => t.number), bestArticleMatch: Math.round(best * 100) / 100, sinceDays: days, sampleText: c.text.slice(0, 400) });
  }
  return { gaps: gaps.sort((a, b) => b.ticketCount - a.ticketCount).slice(0, 20) };
}
