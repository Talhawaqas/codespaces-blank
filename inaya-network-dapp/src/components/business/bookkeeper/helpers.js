"use client";

import { api } from "../nas/ui";

export const BASE = "/api/orgs/finance/bookkeeper";
export const q = (orgId, extra = "") => `orgId=${encodeURIComponent(orgId)}${extra}`;
export const get = (orgId, path, extra = "") => api(`${BASE}/${path}?${q(orgId, extra)}`);
export const send = (orgId, path, body = {}, method = "POST", headers = {}) => api(`${BASE}/${path}?${q(orgId)}`, { method, body: JSON.stringify({ orgId, ...body }), headers });

export const money = (n, cur) => (n === null || n === undefined ? "—" : `${cur || ""} ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim());
export const pct = (n) => (n === null || n === undefined ? "—" : `${(Math.round(n * 1000) / 10).toFixed(1)}%`);

export const TONE = {
  RECONCILED: "OK", CONFIRMED: "OK", AUTO_MATCHED: "OK", EXTRACTED: "OK", PROCESSED: "OK", RESOLVED: "OK", COMPLETED: "OK", RUNNING: "OK", CLOSED: "OK",
  SUGGESTED: "WARNING", HUMAN_REVIEW: "WARNING", NEEDS_REVIEW: "WARNING", UNMATCHED: "WARNING", OPEN: "WARNING", ATTENTION: "WARNING", DEFERRED: "WARNING", IN_REVIEW: "WARNING", medium: "WARNING",
  EXCEPTION: "CRITICAL", DISPUTED: "CRITICAL", FAILED: "CRITICAL", DUPLICATE: "CRITICAL", REJECTED: "CRITICAL", REVERSED: "CRITICAL", BLOCKING: "CRITICAL", high: "CRITICAL",
};
export const tone = (v) => TONE[v] || v;

export function readAsBase64(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] || ""); r.onerror = () => reject(new Error("Could not read the file.")); r.readAsDataURL(file); });
}
export const readAsText = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error("Could not read the file.")); r.readAsText(file); });

export async function download(orgId, path, extra, fallbackName) {
  const res = await fetch(`${BASE}/${path}?${q(orgId, extra)}`);
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Download failed (${res.status}).`); }
  const cd = res.headers.get("content-disposition") || ""; const name = /filename="([^"]+)"/.exec(cd)?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob()); const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
