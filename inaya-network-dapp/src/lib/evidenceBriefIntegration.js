// src/lib/evidenceBriefIntegration.js
//
// Evidence Graph -> Business Brief. A deterministic highlight about the org's Business Events (the Evidence Graph's unit of
// "what happened to this record and why"): how many were opened in the brief's period and how many are still waiting for a
// decision. Counted only across events this reader may see (listBusinessEvents applies the same permission filter as the
// Evidence Graph views), and never allowed to fail the brief (the caller catches).

import { listBusinessEvents } from "./businessEvents.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `list` is injectable so the counting rules can be tested without a database. */
export async function evidenceGraphBullets({ orgId, membership, sinceIso, list = listBusinessEvents }) {
  const events = await list({ orgId, membership });
  if (!events.length) return [];
  const since = Date.parse(sinceIso);
  const opened = events.filter((e) => Date.parse(e.createdAt) >= since);
  const waiting = events.filter((e) => e.status === "OPEN");
  const bullets = [];
  if (opened.length) bullets.push(`${plural(opened.length, "business event")} opened in the Evidence Graph.`);
  if (waiting.length) {
    const oldest = waiting.reduce((a, b) => (Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b));
    const days = Math.floor((Date.now() - Date.parse(oldest.createdAt)) / 86_400_000);
    bullets.push(`${plural(waiting.length, "business event")} still awaiting a decision${days >= 1 ? ` (the oldest for ${plural(days, "day")})` : ""}.`);
  }
  return bullets;
}
