// src/lib/workforce/workingAt.js -- client-side "Working at" branch choice (Commerce Phase 6). Only a convenience for which
// branch the screens open on: the server still checks every request against the user's assigned branches.
const key = (orgId) => `inaya.workingAt.${orgId}`;
export const ALL = "__all__";
export function getWorkingAt(orgId) { try { return (typeof window !== "undefined" && window.localStorage.getItem(key(orgId))) || null; } catch { return null; } }
export function setWorkingAt(orgId, id) {
  try { if (id) window.localStorage.setItem(key(orgId), id); else window.localStorage.removeItem(key(orgId)); } catch { /* storage blocked */ }
  try { window.dispatchEvent(new CustomEvent("inaya:workingAt", { detail: { orgId, id } })); } catch { /* old browser */ }
}
/** Resolve the saved choice against the branches the user may use; falls back to their default branch. */
export function resolveWorkingAt(orgId, me) {
  if (!me) return null; const saved = getWorkingAt(orgId);
  if (saved === ALL && me.canSeeAll) return ALL;
  if (saved && me.locations.some((l) => l.id === saved)) return saved;
  return me.defaultLocationId || me.locations[0]?.id || null;
}
