"use client";

// src/components/business/DocUx.js -- file management UX (Competitive Expansion SOW §38, UX-001): list/grid toggle, favorites, pins, personal tags,
// recent, shared-with-me, locked and legal-hold filters, classification badges. Favorites, pins, tags and recent are personal aids (they grant
// nothing); badges come from the document record. The card itself (actions, share, history) is the existing DocumentCard, passed in as renderCard.

import { useMemo, useState } from "react";

const muted = "text-[var(--inaya-text-muted)]";
const chip = "text-[10px] font-bold uppercase border rounded-full px-2 py-0.5";
const btn = "text-[10px] font-bold uppercase px-2 py-1 rounded-md border border-[var(--inaya-overlay-10)] bg-[var(--inaya-overlay-5)] hover:bg-[var(--inaya-overlay-10)]";
const post = (body) => fetch("/api/orgs/file-prefs", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Could not save."); return d; });
export const touchDocument = (orgId, documentId) => post({ orgId, documentId, touch: true }).catch(() => {});

function Badges({ d }) {
  return (
    <div className="flex flex-wrap gap-1">
      {d.classification && <span className={`${chip} ${/RESTRICTED|HIGHLY|PRIVILEGED|REGULATED/.test(d.classification) ? "text-red-300 border-red-400/40" : "text-amber-300 border-amber-400/40"}`} title="Classification">{d.classification.replace(/_/g, " ")}</span>}
      {d.locked && <span className={`${chip} text-sky-300 border-sky-400/40`} title={d.lockedBy ? `Locked by ${d.lockedBy}` : "Locked"}>Locked</span>}
      {d.legalHold && <span className={`${chip} text-red-300 border-red-400/40`}>Legal hold</span>}
      {!d.mine && <span className={`${chip} ${muted} border-[var(--inaya-overlay-10)]`}>Shared with me</span>}
    </div>
  );
}

function Meta({ d, prefs, orgId, setPrefs }) {
  const [tag, setTag] = useState(""); const [err, setErr] = useState("");
  const run = async (body) => { setErr(""); try { setPrefs(d.id, await post({ orgId, documentId: d.id, ...body })); } catch (e) { setErr(e.message); } };
  return (
    <div className="flex flex-wrap items-center gap-1 mb-1">
      <button aria-label={prefs.favorite ? "Remove favorite" : "Add favorite"} aria-pressed={prefs.favorite} className={btn} onClick={() => run({ favorite: !prefs.favorite })}>{prefs.favorite ? "★ Favorite" : "☆ Favorite"}</button>
      <button aria-label={prefs.pinned ? "Unpin" : "Pin"} aria-pressed={prefs.pinned} className={btn} onClick={() => run({ pinned: !prefs.pinned })}>{prefs.pinned ? "📌 Pinned" : "Pin"}</button>
      {prefs.tags.map((t) => <button key={t} className={`${chip} text-[#00f2fe] border-[#00f2fe]/30`} title="Remove tag" onClick={() => run({ removeTag: t })}>#{t} ×</button>)}
      <input aria-label="Add tag" value={tag} onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && tag.trim()) { run({ addTag: tag.trim() }); setTag(""); } }} placeholder="+ tag" className="w-16 bg-transparent border-b border-[var(--inaya-overlay-10)] text-[11px] px-1" />
      <Badges d={d} />{err && <span className="text-red-400 text-[11px]" role="alert">{err}</span>}
    </div>
  );
}

export default function DocumentList({ documents, orgId, renderCard }) {
  const [mode, setMode] = useState("list"); const [filter, setFilter] = useState("all"); const [cls, setCls] = useState(""); const [tag, setTag] = useState("");
  const [over, setOver] = useState({}); // documentId -> prefs, updated locally after a save
  const prefsOf = (d) => over[d.id] || d.prefs || { favorite: false, pinned: false, tags: [], recentAt: null };
  const setPrefs = (id, p) => setOver((o) => ({ ...o, [id]: p }));
  const classes = useMemo(() => [...new Set(documents.map((d) => d.classification).filter(Boolean))].sort(), [documents]);
  const tags = useMemo(() => [...new Set(documents.flatMap((d) => prefsOf(d).tags))].sort(), [documents, over]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const week = Date.now() - 14 * 86400_000;
    const list = documents.filter((d) => { const p = prefsOf(d);
      if (filter === "favorites" && !p.favorite) return false; if (filter === "pinned" && !p.pinned) return false; if (filter === "recent" && !(p.recentAt && new Date(p.recentAt).getTime() > week)) return false;
      if (filter === "shared" && d.mine) return false; if (filter === "locked" && !d.locked) return false; if (filter === "hold" && !d.legalHold) return false;
      if (cls && d.classification !== cls) return false; if (tag && !p.tags.includes(tag)) return false; return true; });
    return list.sort((a, b) => (prefsOf(b).pinned - prefsOf(a).pinned) || (filter === "recent" ? String(prefsOf(b).recentAt).localeCompare(String(prefsOf(a).recentAt)) : 0));
  }, [documents, filter, cls, tag, over]); // eslint-disable-line react-hooks/exhaustive-deps
  const F = [["all", "All"], ["favorites", "Favorites"], ["pinned", "Pinned"], ["recent", "Recent"], ["shared", "Shared with me"], ["locked", "Locked"], ["hold", "Legal hold"]];
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 mb-2">
        {F.map(([k, l]) => <button key={k} className={`${btn} ${filter === k ? "!border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setFilter(k)}>{l}</button>)}
        {classes.length > 0 && <select aria-label="Classification" className="bg-black/45 border border-[var(--inaya-overlay-15)] rounded-md text-[10px] px-1 py-1" value={cls} onChange={(e) => setCls(e.target.value)}><option value="">Any classification</option>{classes.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select>}
        {tags.length > 0 && <select aria-label="Tag" className="bg-black/45 border border-[var(--inaya-overlay-15)] rounded-md text-[10px] px-1 py-1" value={tag} onChange={(e) => setTag(e.target.value)}><option value="">Any tag</option>{tags.map((t) => <option key={t} value={t}>#{t}</option>)}</select>}
        <span className="ml-auto flex gap-1"><button aria-pressed={mode === "list"} className={`${btn} ${mode === "list" ? "!border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setMode("list")}>List</button><button aria-pressed={mode === "grid"} className={`${btn} ${mode === "grid" ? "!border-[#00f2fe]/40 !text-[#00f2fe]" : ""}`} onClick={() => setMode("grid")}>Grid</button></span>
      </div>
      {shown.length === 0 ? <p className={`text-[12px] ${muted}`}>No documents match this filter.</p> : (
        <div className={mode === "grid" ? "grid grid-cols-1 xl:grid-cols-2 gap-2" : "space-y-2"}>
          {shown.map((d) => <div key={d.id}><Meta d={d} prefs={prefsOf(d)} orgId={orgId} setPrefs={setPrefs} />{renderCard(d)}</div>)}
        </div>)}
    </div>
  );
}
