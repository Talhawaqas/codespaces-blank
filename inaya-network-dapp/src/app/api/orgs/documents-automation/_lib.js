// src/app/api/orgs/documents-automation/_lib.js
//
// Shared plumbing for every Document Automation endpoint (SOW §33). Every
// endpoint enforces, in this order: authentication (session cookie),
// organization scope (requireMembership -- the org is verified against the
// caller's own membership, never trusted from the client), permission (in
// the library function it calls), ownership/access (per-document
// visibility), rate limiting, and audit (each library function writes to
// the org's audit chain). Route files stay thin wrappers over the library.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";
const MAX_JSON_BYTES = 512 * 1024;
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

/** Converts a library { error, status, ... } / { ...ok } result to a response. */
export function respond(result, okStatus = 200) {
  if (result?.error) {
    const { error, status, validation, documentId, pipelineState, sod, stale, inProgress, duplicate, ndaRequired, errors, reasonCode } = result;
    return NextResponse.json({ error, ...(validation ? { validation } : {}), ...(errors ? { errors } : {}), ...(documentId ? { documentId } : {}), ...(pipelineState ? { pipelineState } : {}), ...(sod ? { sod } : {}), ...(stale ? { stale } : {}), ...(inProgress ? { inProgress } : {}), ...(duplicate ? { duplicate } : {}), ...(ndaRequired ? { ndaRequired } : {}), ...(reasonCode ? { reasonCode } : {}) }, { status: status || 400 });
  }
  return NextResponse.json(result, { status: okStatus });
}

export function fail(err, label) {
  console.error(`documents-automation ${label} failed:`, err);
  return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
}

/** Authenticates the caller for an org. Returns { auth } or { response }. */
export async function authed(req, orgId, options) {
  if (!orgId || typeof orgId !== "string" || orgId.length > 40) return { response: NextResponse.json({ error: "orgId is required." }, { status: 400 }) };
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId, options);
  if (auth.error) return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  return { auth, email: auth.session.email, membership: auth.membership };
}

/** Per-user (or per-IP when anonymous) rate limit. Returns a 429 response or null. */
export async function limited(req, { action, max = 60, windowMs = 15 * 60 * 1000, key }) {
  try {
    await checkRateLimit({ action: `docauto:${action}`, key: key || getClientIp(req), max, windowMs });
    return null;
  } catch {
    return NextResponse.json({ error: "Too many requests. Please wait a moment and try again." }, { status: 429 });
  }
}

export async function readJson(req, maxBytes = MAX_JSON_BYTES) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > maxBytes) return { error: "Request body is too large.", status: 413 };
  try {
    const text = await req.text();
    if (text.length > maxBytes) return { error: "Request body is too large.", status: 413 };
    return { body: text ? JSON.parse(text) : {} };
  } catch {
    return { error: "Request body must be valid JSON.", status: 400 };
  }
}

export async function readPdf(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_PDF_BYTES) return { error: "File is too large.", status: 413 };
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const j = await readJson(req, 25 * 1024 * 1024);
    if (j.error) return j;
    if (typeof j.body.pdfBase64 !== "string") return { error: "pdfBase64 is required.", status: 400 };
    const buf = Buffer.from(j.body.pdfBase64, "base64");
    if (buf.length > MAX_PDF_BYTES) return { error: "File is too large.", status: 413 };
    return { bytes: buf };
  }
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) return { error: "File is too large.", status: 413 };
  return { bytes: buf };
}

export function pdfResponse(buffer, filename, { hash, inline = true } = {}) {
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${String(filename).replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "Content-Length": String(buffer.length),
      ...(hash ? { "X-Document-Hash": hash } : {}),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
