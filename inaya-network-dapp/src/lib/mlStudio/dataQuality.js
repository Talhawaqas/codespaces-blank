// src/lib/mlStudio/dataQuality.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream B governance slice, §"data quality rules
// engine". Rules only apply to TABLE catalog entries (a real SQL source), and run through the EXISTING
// legacyDataAccess SQL gateway (executeVirtualQuery) -- never a second query engine, never write access
// (the gateway itself is read-only this pass, so a data-quality rule can only ever be a SELECT-shaped check).

import { toObjectId, canManageOrg } from "../orgs.js";
import { executeVirtualQuery } from "../legacyDataAccess/sqlGateway.js";
import { getMlStudioCollections, ensureMlStudioIndexes } from "./db.js";
import { getCatalogEntry } from "./catalog.js";
import { fail, nowIso } from "../docIntelligence/common.js";
import { event, notify } from "./record.js";

export const RULE_TYPES = ["NOT_NULL", "UNIQUE", "RANGE", "REGEX", "ROW_COUNT_MIN"];
const ident = (s) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s);
const ruleView = (r) => ({ ruleId: String(r._id), catalogId: String(r.catalogId), type: r.type, column: r.column || null, params: r.params || {}, createdAt: r.createdAt });

export async function createRule({ orgId, membership, actorEmail, catalogId, type, column = null, params = {} }) {
  if (!canManageOrg(membership)) return fail("Only the owner or an admin can create a data quality rule.", 403);
  if (!RULE_TYPES.includes(type)) return fail(`type must be one of ${RULE_TYPES.join(", ")}.`);
  if (type !== "ROW_COUNT_MIN" && (!column || !ident(column))) return fail("A valid column name is required for this rule type.");
  const entry = await getCatalogEntry({ orgId, catalogId });
  if (!entry) return fail("Catalog entry not found.", 404);
  if (entry.type !== "TABLE") return fail("Data quality rules only apply to TABLE catalog entries.", 400);
  await ensureMlStudioIndexes();
  const c = await getMlStudioCollections();
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), catalogId: entry._id, type, column, params, createdAt: now, createdBy: actorEmail };
  doc._id = (await c.mlDataQualityRules.insertOne(doc)).insertedId;
  await event({ orgId, type: "DATA_QUALITY_RULE_CREATED", recordId: doc._id, actorEmail, metadata: { catalogId: String(entry._id), ruleType: type, column } });
  return { rule: ruleView(doc) };
}

export async function listRules({ orgId, catalogId }) {
  const c = await getMlStudioCollections();
  return { rules: (await c.mlDataQualityRules.find({ orgId: toObjectId(orgId), catalogId: toObjectId(catalogId) }).toArray()).map(ruleView) };
}

function whereFor(rule) {
  if (rule.type === "NOT_NULL") return `${rule.column} IS NULL`;
  if (rule.type === "UNIQUE") return null; // handled separately -- needs a GROUP BY, not a single WHERE
  if (rule.type === "RANGE") { const { min, max } = rule.params || {}; const parts = []; if (min !== undefined) parts.push(`${rule.column} < ${Number(min)}`); if (max !== undefined) parts.push(`${rule.column} > ${Number(max)}`); return parts.length ? parts.join(" OR ") : null; }
  if (rule.type === "REGEX") return null; // SQLite's reference connector has no portable REGEXP -- honestly unsupported, see runRule()
  return null;
}

/** Runs one rule against its catalog entry's real table via the EXISTING SQL gateway. Returns
 *  { passed, checked, violations, detail } -- never a single opaque pass/fail with no numbers behind it. */
export async function runRule({ orgId, membership, actorEmail, ruleId }) {
  const c = await getMlStudioCollections();
  let oid; try { oid = toObjectId(ruleId); } catch { return fail("Rule not found.", 404); }
  const rule = await c.mlDataQualityRules.findOne({ _id: oid, orgId: toObjectId(orgId) });
  if (!rule) return fail("Rule not found.", 404);
  const entry = await getCatalogEntry({ orgId, catalogId: rule.catalogId });
  if (!entry) return fail("The catalog entry behind this rule no longer exists.", 404);
  const table = entry.ref.tableName;
  if (!ident(table)) return fail("The catalog entry's table name is not safe to query.", 400);

  let result;
  if (rule.type === "ROW_COUNT_MIN") {
    result = await executeVirtualQuery({ orgId, dataSourceId: entry.ref.dataSourceId, sql: `SELECT COUNT(*) AS n FROM ${table}`, membership, actorEmail, maxRows: 1 });
    if (result.error) return fail(result.error, result.status || 400);
    const n = Number(result.rows?.[0]?.n || 0); const min = Number(rule.params?.min || 0);
    return recordRun({ orgId, actorEmail, rule, passed: n >= min, checked: n, violations: n < min ? min - n : 0, detail: `${n} rows (minimum required: ${min}).` });
  }
  if (rule.type === "UNIQUE") {
    result = await executeVirtualQuery({ orgId, dataSourceId: entry.ref.dataSourceId, sql: `SELECT ${rule.column} AS v, COUNT(*) AS n FROM ${table} GROUP BY ${rule.column} HAVING COUNT(*) > 1`, membership, actorEmail, maxRows: 1000 });
    if (result.error) return fail(result.error, result.status || 400);
    const dupes = result.rows?.length || 0;
    return recordRun({ orgId, actorEmail, rule, passed: dupes === 0, checked: null, violations: dupes, detail: dupes ? `${dupes} duplicate value(s) found in ${rule.column}.` : `No duplicates found in ${rule.column}.` });
  }
  if (rule.type === "REGEX") return fail("REGEX rules are not supported by the reference connector's SQL engine (no portable REGEXP). Honestly unsupported rather than silently skipped.", 400);
  const where = whereFor(rule);
  if (!where) return fail(`Rule type "${rule.type}" could not be translated to SQL.`, 400);
  const [totalR, badR] = await Promise.all([
    executeVirtualQuery({ orgId, dataSourceId: entry.ref.dataSourceId, sql: `SELECT COUNT(*) AS n FROM ${table}`, membership, actorEmail, maxRows: 1 }),
    executeVirtualQuery({ orgId, dataSourceId: entry.ref.dataSourceId, sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, membership, actorEmail, maxRows: 1 }),
  ]);
  if (totalR.error) return fail(totalR.error, totalR.status || 400);
  if (badR.error) return fail(badR.error, badR.status || 400);
  const total = Number(totalR.rows?.[0]?.n || 0); const bad = Number(badR.rows?.[0]?.n || 0);
  return recordRun({ orgId, actorEmail, rule, passed: bad === 0, checked: total, violations: bad, detail: bad ? `${bad} of ${total} rows violate this rule.` : `All ${total} rows pass.` });
}

async function recordRun({ orgId, actorEmail, rule, passed, checked, violations, detail }) {
  const c = await getMlStudioCollections();
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), catalogId: rule.catalogId, ruleId: rule._id, ruleType: rule.type, passed, checked, violations, detail, createdAt: now, createdBy: actorEmail };
  doc._id = (await c.mlDataQualityRuns.insertOne(doc)).insertedId;
  await event({ orgId, type: "DATA_QUALITY_RUN", recordId: doc._id, actorEmail, metadata: { ruleId: String(rule._id), ruleType: rule.type, passed, violations } });
  if (!passed) notify({ orgId, title: "Data quality rule failed", body: detail, dedupeKey: `mlstudio:dq:${rule._id}:${now}`, severity: "warning", recordId: doc._id });
  return { run: { runId: String(doc._id), passed, checked, violations, detail, createdAt: now } };
}

export async function listRuns({ orgId, catalogId, limit = 20 }) {
  const c = await getMlStudioCollections();
  const runs = await c.mlDataQualityRuns.find({ orgId: toObjectId(orgId), catalogId: toObjectId(catalogId) }).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).toArray();
  return { runs: runs.map((r) => ({ runId: String(r._id), ruleType: r.ruleType, passed: r.passed, checked: r.checked, violations: r.violations, detail: r.detail, createdAt: r.createdAt })) };
}
