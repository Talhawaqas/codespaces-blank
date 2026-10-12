// src/lib/search/unified.js
//
// Unified search v2 (Competitive Expansion SOW workstream H, SEARCH-001). Builds on src/lib/orgSearch.js, whose ONLY data source is getAccessibleScope()
// (everything it searches is already permission-filtered), and adds: file metadata and classification, your own tags, shares you created, file requests
// you created, data rooms (managers), and navigation to pages (Secure Chat, Notes, Governance, ...) for the command palette.
//
// PRIVACY TIERS (reported with every response, never hidden):
//   A  end-to-end encrypted content (Secure Notes, Secure Chat): the server cannot read it, so it is searched in YOUR browser over what that browser has
//      decrypted. Nothing about it appears here.
//   B  permissioned enterprise content: this module, over records the caller may already see. Document TEXT is not indexed (documents are client-side
//      encrypted); filenames, paths, metadata, classification and tags are.
//   C  a customer-controlled gateway index: NOT_CONFIGURED until a Sovereign Gateway with an index is connected.
// Filters: classification, locked, legalHold, type (extension), favorite, pinned, tag.

import { getAccessibleScope } from "../document-permissions.js";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { searchOrg } from "../orgSearch.js";
import { hasAdminRole, canManageOrg } from "../orgGates.js";
import { prefsForDocs } from "../filePrefs.js";
import { activeLock } from "../filelocks.js";
import { NAV_ITEMS, isNavItemVisible, searchWordsFor } from "../navigation/navItems.js";
import { getOrgProfile } from "../industry-config.js";

const lc = (v) => String(v ?? "").toLowerCase();
const extOf = (n) => (String(n).includes(".") ? lc(String(n).split(".").pop()) : "");

export const TIERS = { A: { status: "LOCAL", note: "Notes and chats are end-to-end encrypted. They are searched in your browser, over what this browser has decrypted, and never here." }, B: { status: "OK", note: "Searches names, paths, metadata, classification and your tags for what you may already see. Document text is not indexed." }, C: { status: "NOT_CONFIGURED", note: "A customer-controlled gateway index is not connected." } };

export async function unifiedSearch({ orgId, membership, email, query, filters = {}, limit = 30 }) {
  const q = lc(query).trim(); const hasFilters = Object.values(filters).some((v) => v !== undefined && v !== "" && v !== false);
  if (q.length < 2 && !hasFilters) return { results: [], tiers: TIERS };
  const out = []; const seen = new Set(); const push = (r) => { const k = `${r.entityType}:${r.id}`; if (seen.has(k) || out.length >= limit) return; seen.add(k); out.push(r); };

  // navigation (command palette): every NAV_ITEMS entry the caller may open -- same source of truth and
  // gating as the sidebar (src/lib/navigation/navItems.js), so this list can never drift out of sync with
  // it again the way the old hand-written PAGES array (17 of 72 modules) did.
  if (q.length >= 2) {
    const vertical = (await getOrgProfile(orgId))?.vertical || "general";
    const canManage = canManageOrg(membership);
    for (const item of NAV_ITEMS) {
      if (!isNavItemVisible(item, { canManage, membership, vertical })) continue;
      if (lc(item.label).includes(q) || searchWordsFor(item).includes(q)) push({ entityType: "page", id: item.key, title: item.label, subtitle: "Go to", view: item.key, actionUrl: `/business?view=${item.key}` });
    }
  }

  // documents: name (existing search) plus metadata, classification, tags, path. Permission-filtered by getAccessibleScope.
  const scope = await getAccessibleScope({ orgId, membership, email }); const docs = scope.visibleDocuments || [];
  const prefs = await prefsForDocs({ orgId, email, documentIds: docs.map((d) => String(d._id)) }).catch(() => new Map());
  const c = await getOrgCollections(); const defs = await c.db.collection("metadata_fields").find({ orgId: toObjectId(orgId), archived: { $ne: true } }).project({ key: 1, visibility: 1 }).toArray().catch(() => []);
  const managerOnly = new Set(defs.filter((d) => d.visibility === "managers").map((d) => d.key)); const canSeeManagerFields = canManageOrg(membership) || hasAdminRole(membership, "dataGovernanceAdmin");
  for (const d of docs) {
    const p = prefs.get(String(d._id)); const lock = activeLock(d);
    if (filters.classification && d.classification !== filters.classification) continue; if (filters.locked && !lock) continue; if (filters.legalHold && !d.legalHold) continue;
    if (filters.type && extOf(d.filename) !== lc(filters.type).replace(/^\./, "")) continue; if (filters.favorite && !p?.favorite) continue; if (filters.pinned && !p?.pinned) continue; if (filters.tag && !(p?.tags || []).includes(filters.tag)) continue;
    let why = null;
    if (q.length < 2) why = "matches your filters";
    else if (lc(d.filename).includes(q)) why = "file name";
    else if (lc(d.classification).includes(q.replace(/ /g, "_")) || lc(d.classification).includes(q)) why = "classification";
    else if ((p?.tags || []).some((t) => lc(t).includes(q))) why = "your tag";
    else { for (const [k, v] of Object.entries(d.metadata || {})) { if (managerOnly.has(k) && !canSeeManagerFields) continue; if (typeof v === "string" && lc(v).includes(q)) { why = `metadata (${k})`; break; } } }
    if (!why) continue;
    push({ entityType: "document", id: String(d._id), title: d.filename, subtitle: [d.classification && d.classification.replace(/_/g, " "), lock && "locked", d.legalHold && "legal hold", `matched ${why}`].filter(Boolean).join(" · "), view: "documents", actionUrl: "/business?view=documents", badges: { classification: d.classification || null, locked: !!lock, legalHold: !!d.legalHold } });
  }
  if (q.length >= 2 && !hasFilters) {
    // everything else the existing search covers (tasks, contacts, invoices, ...)
    for (const r of await searchOrg({ orgId, membership, email, query, limit })) push(r);
    // shares and file requests you created; data rooms for managers
    const mine = lc(email);
    for (const s of await c.documentShares.find({ orgId: toObjectId(orgId), createdByEmail: mine, v: 2, revokedAt: null }).limit(200).toArray()) { const label = s.label || ""; if (lc(label).includes(q)) push({ entityType: "share", id: String(s._id), title: label, subtitle: "your share link", view: "shares", actionUrl: "/business?view=shares" }); }
    for (const r of await c.db.collection("file_requests").find({ orgId: toObjectId(orgId), createdByEmail: mine }).project({ title: 1 }).limit(200).toArray().catch(() => [])) if (lc(r.title).includes(q)) push({ entityType: "file request", id: String(r._id), title: r.title, subtitle: "your file request", view: "fileRequests", actionUrl: "/business?view=fileRequests" });
    if (canManageOrg(membership) || hasAdminRole(membership, "vdrAdmin")) for (const r of await c.dataRooms.find({ orgId: toObjectId(orgId) }).project({ name: 1, roomType: 1 }).limit(200).toArray()) if (lc(r.name).includes(q)) push({ entityType: "data room", id: String(r._id), title: r.name, subtitle: `${r.roomType} data room`, view: "dataRooms", actionUrl: "/business?view=dataRooms" });
  }
  return { results: out, tiers: TIERS };
}
