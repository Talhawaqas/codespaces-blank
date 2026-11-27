// app/api/analytics/_lib.js -- shared plumbing for the Power BI Analytics API and its OAuth endpoints (src/lib/analytics/*).
// Errors never include stack traces or internal details (SOW 6.1); request bodies and tokens are never logged.
import { NextResponse } from "next/server";
import { OAuthError } from "../../../lib/analytics/oauth.js";
import { DatasetError } from "../../../lib/analytics/datasets.js";

export const json = (d, s = 200, extra = {}) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store", Pragma: "no-cache", ...extra } });
export function handle(err, where) {
  if (err instanceof OAuthError) return json({ error: err.error, error_description: err.message }, err.status, err.status === 401 ? { "WWW-Authenticate": `Bearer error="${err.error}"` } : {});
  if (err instanceof DatasetError) return json({ error: "invalid_request", error_description: err.message }, err.status);
  console.error(`analytics ${where} failed:`, err?.name);
  return json({ error: "server_error", error_description: "Something went wrong. Please try again." }, 500);
}
export async function readForm(req) {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) { try { return await req.json(); } catch { return {}; } }
  try { return Object.fromEntries((await req.formData()).entries()); } catch { return {}; }
}
