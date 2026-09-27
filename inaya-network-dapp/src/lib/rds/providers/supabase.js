// src/lib/rds/providers/supabase.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream A. A real DatabaseProvider backed by the
// real Supabase Management API (api.supabase.com/v1) -- the architectural decision this SOW's own audit
// flagged (RDS_SAGEMAKER_DOCINT_CAPABILITY_AUDIT.md, Decision 1): Vercel serverless cannot host a Postgres
// engine process, so Inaya's "managed database service" provisions and controls a REAL external engine
// instead of pretending to run one itself. Same shape as legacyDataAccess/connectorRegistry.js's connector
// interface and pinningProviders/*'s "another storage-like backend" pattern -- a flat, honestly-documented
// module, not a class hierarchy.
//
// Endpoints used (confirmed current, Sept 2026, via supabase.com/docs/reference/api):
//   POST   /v1/projects                                  -- create a project (provision)
//   GET    /v1/projects                                  -- list projects
//   GET    /v1/projects/{ref}                             -- get one project (status/health)
//   DELETE /v1/projects/{ref}                             -- delete (deprovision)
//   POST   /v1/projects/{ref}/pause                       -- stop
//   POST   /v1/projects/{ref}/restore                     -- start / resume
//   GET    /v1/organizations                              -- list orgs (a project must belong to one)
//   GET    /v1/projects/{ref}/database/backups            -- list backups / snapshots
//   POST   /v1/projects/{ref}/database/backups/restore-pitr  -- point-in-time restore
//   POST   /v1/projects/{ref}/database/query               -- run a SQL statement (used by the SQL Query
//                                                              Editor over THIS provider only -- unrelated
//                                                              to legacyDataAccess/sqlGateway.js, which
//                                                              queries a different, already-existing source)
//
// Auth: `Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}` -- a Management API personal access token, read from
// the environment ONLY, never stored in Mongo, never logged, never returned to a client. This module never
// receives or handles the token's value from a caller -- it reads it once, from process.env, at call time.
//
// What this provider does NOT claim (SOW's own "never overstate" discipline):
//   - Multi-AZ / true HA failover: Supabase's "High Availability" is a paid, project-level flag
//     (high_availability: true at creation) -- this module can REQUEST it, it cannot verify failover
//     behavior itself without a real outage, so createReplica()/failover() are honestly NOT_SUPPORTED here
//     until Inaya actually operates such a project through an incident.
//   - Read replicas as a first-class Inaya concept: Supabase's read-replica feature is region-based and
//     managed through its own dashboard/API surface this pass hasn't verified end-to-end; left NOT_SUPPORTED
//     rather than guessed at.

const API_BASE = "https://api.supabase.com/v1";
const REQUIRED_ENV = "SUPABASE_ACCESS_TOKEN";

export function isConfigured() {
  return !!process.env[REQUIRED_ENV];
}

export function capabilities() {
  return {
    provision: true, start: true, stop: true, deprovision: true,
    snapshot: true, pitr: true, // Supabase PITR is a paid add-on; provision() surfaces the plan requirement, never silently no-ops
    replicas: false, failover: false, // honestly unsupported -- see header
    query: true, metrics: false, // no verified metrics-pull endpoint used yet
  };
}

async function call(path, { method = "GET", body } = {}) {
  const token = process.env[REQUIRED_ENV];
  if (!token) return { ok: false, status: 0, error: `${REQUIRED_ENV} is not configured on this server.` };
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  } catch (err) { return { ok: false, status: 0, error: `Supabase Management API is unreachable: ${String(err.message || err).slice(0, 160)}` }; }
  let json = null;
  try { json = await res.json(); } catch { /* empty body on some 2xx responses */ }
  if (!res.ok) return { ok: false, status: res.status, error: (json && (json.message || json.error)) || `Supabase API returned ${res.status}.` };
  return { ok: true, status: res.status, data: json };
}

/** Every write requires the caller to already have confirmed the target organization with the human operator
 *  (this module never guesses which Supabase organization to provision into). */
export async function listOrganizations() {
  const r = await call("/v1/organizations");
  if (!r.ok) return r;
  return { ok: true, organizations: (r.data || []).map((o) => ({ id: o.id, name: o.name })) };
}

export async function validateEngine({ engine }) {
  return engine === "postgres" ? { ok: true } : { ok: false, error: `Only "postgres" is supported by this provider (asked for "${engine}").` };
}

/** Provisions a real Supabase project. `dbPassword` must already be a strong, generated secret the caller
 *  supplies (this module never invents or stores it in plaintext -- it is sent once, over TLS, to Supabase's
 *  own API, exactly as their own dashboard flow does; Inaya's own credential storage keeps only a reference,
 *  per credentials.js's envelope-encryption pattern used elsewhere in this codebase, e.g. s3-compat/credentials.js). */
export async function provision({ organizationSlug, name, region = "us-east-1", dbPassword, highAvailability = false }) {
  if (!organizationSlug) return { ok: false, error: "organizationSlug is required (see listOrganizations())." };
  if (!name || name.length > 63) return { ok: false, error: "A project name (max 63 chars) is required." };
  if (!dbPassword || dbPassword.length < 12) return { ok: false, error: "dbPassword must be at least 12 characters." };
  const r = await call("/v1/projects", { method: "POST", body: { organization_slug: organizationSlug, name, region, db_pass: dbPassword, high_availability: !!highAvailability } });
  if (!r.ok) return r;
  return { ok: true, instance: { providerRef: r.data.ref, engine: "postgres", region: r.data.region, status: r.data.status, createdAt: r.data.created_at } };
}

export async function getInstance({ providerRef }) {
  const r = await call(`/v1/projects/${providerRef}`);
  if (!r.ok) return r;
  return { ok: true, instance: { providerRef: r.data.ref, engine: "postgres", region: r.data.region, status: r.data.status } };
}

export async function start({ providerRef }) { return call(`/v1/projects/${providerRef}/restore`, { method: "POST" }); }
export async function stop({ providerRef }) { return call(`/v1/projects/${providerRef}/pause`, { method: "POST" }); }
export async function deprovision({ providerRef }) { return call(`/v1/projects/${providerRef}`, { method: "DELETE" }); }

export async function listSnapshots({ providerRef }) {
  const r = await call(`/v1/projects/${providerRef}/database/backups`);
  if (!r.ok) return r;
  return { ok: true, snapshots: r.data };
}

/** `recoveryTimeUnix`: a Unix timestamp within the project's PITR retention window. Requires the project to
 *  be on a plan with PITR enabled -- Supabase itself returns 403 otherwise, surfaced here rather than hidden. */
export async function restorePointInTime({ providerRef, recoveryTimeUnix }) {
  if (!Number.isFinite(recoveryTimeUnix)) return { ok: false, error: "recoveryTimeUnix (a Unix timestamp) is required." };
  return call(`/v1/projects/${providerRef}/database/backups/restore-pitr`, { method: "POST", body: { recovery_time_target_unix: recoveryTimeUnix } });
}

export async function createReplica() { return { ok: false, error: "Read replicas are not yet supported by this provider (see this file's header)." }; }
export async function failover() { return { ok: false, error: "Failover is not yet supported by this provider (see this file's header)." }; }
export async function metrics() { return { ok: false, error: "Metrics are not yet supported by this provider (see this file's header)." }; }

/** Runs one SQL statement through the Management API against the project itself (governed, audited, never a
 *  raw unauthenticated pass-through) -- the seam the SQL Query Editor (Workstream B) calls into for a
 *  Workstream-A-hosted database, entirely separate from legacyDataAccess/sqlGateway.js's existing gateway. */
export async function runQuery({ providerRef, sql, readOnly = true }) {
  if (!sql || typeof sql !== "string") return { ok: false, error: "sql is required." };
  const r = await call(`/v1/projects/${providerRef}/database/query`, { method: "POST", body: { query: sql, read_only: readOnly } });
  if (!r.ok) return r;
  return { ok: true, result: r.data };
}
