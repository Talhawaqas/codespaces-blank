// src/lib/docIntelligence/common.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream C. Shared small helpers, same shape as
// bookkeeper/common.js and support/common.js — no new pattern invented here.

import { createHash } from "node:crypto";

export const nowIso = () => new Date().toISOString();
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const clamp01 = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0; };
export const round4 = (n) => Math.round(Number(n) * 10000) / 10000;
export const fail = (error, status = 400, extra = {}) => ({ error, status, ...extra });

export function safeFilename(name) {
  const base = String(name || "document").replace(/[\\/]/g, "_").replace(/[^\w.\- ]/g, "_").trim().slice(0, 180);
  return base || "document";
}

// Analyzer lifecycle (SOW §2 status taxonomy applied to analyzer versions, and the SOW's own mandatory
// status labels §27): a DRAFT/TESTING analyzer can still run (so it can be evaluated against real samples)
// but every result it produces is marked testMode so it never gets treated as a production classification.
export const ANALYZER_STATUSES = ["DRAFT", "TESTING", "READY", "ACTIVE", "DISABLED", "ARCHIVED"];
export const ANALYZER_TRANSITIONS = {
  DRAFT: ["TESTING", "ARCHIVED"],
  TESTING: ["READY", "DRAFT", "ARCHIVED"],
  READY: ["ACTIVE", "TESTING", "ARCHIVED"],
  ACTIVE: ["DISABLED", "ARCHIVED"],
  DISABLED: ["ACTIVE", "ARCHIVED"],
  ARCHIVED: [],
};
export const EXTRACTION_METHODS = ["EXTRACT", "CLASSIFY", "GENERATE"];
export const FIELD_TYPES = ["string", "number", "date", "currency", "boolean"];

export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const ALLOWED_TYPES = { "application/pdf": "pdf", "image/jpeg": "image", "image/png": "image", "text/plain": "text", "text/csv": "text" };
export const BAD_EXT = /\.(exe|dll|bat|cmd|com|scr|js|jse|vbs|ps1|msi|jar|sh|app|docm|xlsm|zip|rar|7z|iso|html?|svg)$/i;

export function checkContent(contentType, buffer) {
  if (!ALLOWED_TYPES[contentType]) return "Unsupported file type.";
  if (contentType === "application/pdf" && buffer.slice(0, 5).toString("latin1") !== "%PDF-") return "The file is not a valid PDF.";
  if (contentType === "image/png" && buffer.slice(0, 8).toString("hex") !== "89504e470d0a1a0a") return "The file is not a valid PNG.";
  if (contentType === "image/jpeg" && buffer.slice(0, 2).toString("hex") !== "ffd8") return "The file is not a valid JPEG.";
  return null;
}
