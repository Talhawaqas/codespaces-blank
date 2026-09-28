// AI/ML Studio governance slice (RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream B). Real
// database, real SQLite fixture for the catalog/data-quality path (same technique as
// test/legacy-data-access.test.mjs), real encrypted artifact storage for the model registry path.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { registerDataSource } from "../src/lib/legacyDataAccess/dataSources.js";
import { importAndPublishSchema } from "../src/lib/legacyDataAccess/metadata.js";
import { getMlStudioCollections } from "../src/lib/mlStudio/db.js";
import { registerCatalogEntry, listCatalog } from "../src/lib/mlStudio/catalog.js";
import { createRule, runRule } from "../src/lib/mlStudio/dataQuality.js";
import { registerModel, setModelStatus, listModels, getModel, downloadArtifact } from "../src/lib/mlStudio/models.js";
import { recordEvaluation } from "../src/lib/mlStudio/evaluations.js";
import { flushEvidence } from "../src/lib/mlStudio/record.js";
import { listBusinessEvents } from "../src/lib/businessEvents.js";
import clientPromise from "../src/lib/mongodb.js";

const RUN = randomUUID().slice(0, 8);
const cleanup = { orgIds: [], sqliteFiles: [] };

function makeFixture() {
  const filePath = path.join(os.tmpdir(), `ml-studio-test-${RUN}.sqlite`);
  cleanup.sqliteFiles.push(filePath);
  const db = new DatabaseSync(filePath);
  db.exec(`CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, region TEXT);`);
  const ins = db.prepare("INSERT INTO customers (id, name, region) VALUES (?, ?, ?)");
  ins.run(1, "Acme Corp", "US"); ins.run(2, "Globex", null); ins.run(3, "Acme Corp", "EU"); // a NULL region and a duplicate name, on purpose
  db.close();
  return filePath;
}

after(async () => {
  await flushEvidence().catch(() => {});
  try {
    const c = await getOrgCollections();
    for (const n of (await c.db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name)) { try { await c.db.collection(n).deleteMany({ orgId: { $in: cleanup.orgIds } }); } catch { /* ignore */ } }
    await c.orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
    const ml = await getMlStudioCollections();
    for (const coll of [ml.mlCatalog, ml.mlDataQualityRules, ml.mlDataQualityRuns, ml.mlModelVersions, ml.mlEvaluations]) await coll.deleteMany({ orgId: { $in: cleanup.orgIds } });
  } catch { /* best effort */ }
  for (const f of cleanup.sqliteFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

let orgId, owner, member, dataSourceId, catalogId, modelId, artifactBytes;

test("setup: an org, a real SQLite data source with a published table", async () => {
  await ensureOrgIndexes(); const c = await getOrgCollections();
  const oid = (await c.orgs.insertOne({ name: `ml-studio-${RUN}`, createdAt: new Date().toISOString() })).insertedId;
  orgId = String(oid); cleanup.orgIds.push(oid);
  owner = { role: "owner" }; member = { role: "member" };
  const filePath = makeFixture();
  const { dataSource } = await registerDataSource({ orgId, name: "ML Studio Test Source", connectorType: "relational", credentials: { filePath }, membership: owner, actorEmail: "owner@example.com" });
  assert.equal(dataSource.status, "CONNECTED");
  dataSourceId = String(dataSource._id);
  const { tables } = await importAndPublishSchema({ orgId, dataSourceId: dataSource._id, membership: owner, actorEmail: "owner@example.com" });
  assert.ok(tables.find((t) => t.name === "customers"));
});

test("catalog: a TABLE entry is verified against the real published table before it is accepted", async () => {
  const denied = await registerCatalogEntry({ orgId, membership: member, actorEmail: "x@example.com", name: "Customers", type: "TABLE", ref: { dataSourceId, tableName: "customers" } });
  assert.equal(denied.status, 403);
  const bad = await registerCatalogEntry({ orgId, membership: owner, actorEmail: "owner@example.com", name: "Ghost table", type: "TABLE", ref: { dataSourceId, tableName: "does_not_exist" } });
  assert.ok(bad.error, "a table that was never published must be refused, not silently cataloged");
  const ok = await registerCatalogEntry({ orgId, membership: owner, actorEmail: "owner@example.com", name: "Customers", type: "TABLE", ref: { dataSourceId, tableName: "customers" }, tags: ["crm"] });
  assert.ok(!ok.error, JSON.stringify(ok)); catalogId = ok.entry.catalogId;
  const { entries } = await listCatalog({ orgId, type: "TABLE" });
  assert.ok(entries.some((e) => e.catalogId === catalogId));
});

test("data quality: NOT_NULL and UNIQUE rules run against the real table and report real numbers, never a bare pass/fail", async () => {
  const notNull = await createRule({ orgId, membership: owner, actorEmail: "owner@example.com", catalogId, type: "NOT_NULL", column: "region" });
  assert.ok(!notNull.error, JSON.stringify(notNull));
  const r1 = await runRule({ orgId, membership: owner, actorEmail: "owner@example.com", ruleId: notNull.rule.ruleId });
  assert.equal(r1.run.passed, false); assert.equal(r1.run.violations, 1, "exactly one row has a NULL region");

  const unique = await createRule({ orgId, membership: owner, actorEmail: "owner@example.com", catalogId, type: "UNIQUE", column: "name" });
  const r2 = await runRule({ orgId, membership: owner, actorEmail: "owner@example.com", ruleId: unique.rule.ruleId });
  assert.equal(r2.run.passed, false); assert.equal(r2.run.violations, 1, "\"Acme Corp\" appears twice");

  const rowCount = await createRule({ orgId, membership: owner, actorEmail: "owner@example.com", catalogId, type: "ROW_COUNT_MIN", params: { min: 3 } });
  assert.ok(!rowCount.error, JSON.stringify(rowCount));
  const r3 = await runRule({ orgId, membership: owner, actorEmail: "owner@example.com", ruleId: rowCount.rule.ruleId });
  assert.equal(r3.run.passed, true); assert.equal(r3.run.checked, 3);
});

test("model registry: register, real artifact hash, lifecycle transitions, evaluation with named metrics", async () => {
  const artifact = randomBytes(256); artifactBytes = artifact;
  const deniedRegister = await registerModel({ orgId, membership: member, actorEmail: "x@example.com", modelName: "risk-classifier", version: "1.0.0", datasetCatalogIds: [catalogId], artifactBuffer: artifact, artifactFilename: "model.bin", artifactContentType: "application/octet-stream" });
  assert.equal(deniedRegister.status, 403);

  const reg = await registerModel({ orgId, membership: owner, actorEmail: "owner@example.com", modelName: "risk-classifier", version: "1.0.0", framework: "scikit-learn", datasetCatalogIds: [catalogId], artifactBuffer: artifact, artifactFilename: "model.bin", artifactContentType: "application/octet-stream" });
  assert.ok(!reg.error, JSON.stringify(reg));
  modelId = reg.model.modelId;
  assert.equal(reg.model.status, "DRAFT");
  assert.equal(reg.model.artifact.sizeBytes, 256);
  const { createHash } = await import("node:crypto");
  assert.equal(reg.model.artifact.sha256, createHash("sha256").update(artifact).digest("hex"));

  const dup = await registerModel({ orgId, membership: owner, actorEmail: "owner@example.com", modelName: "risk-classifier", version: "1.0.0", artifactBuffer: artifact, artifactFilename: "model.bin", artifactContentType: "application/octet-stream" });
  assert.equal(dup.status, 409);

  const skip = await setModelStatus({ orgId, membership: owner, actorEmail: "owner@example.com", modelId: reg.model.modelId, status: "ACTIVE" });
  assert.equal(skip.status, 409, "DRAFT -> ACTIVE directly must be rejected, same lifecycle discipline as analyzers");
  for (const status of ["TESTING", "READY", "ACTIVE"]) {
    const s = await setModelStatus({ orgId, membership: owner, actorEmail: "owner@example.com", modelId: reg.model.modelId, status });
    assert.equal(s.model.status, status, JSON.stringify(s));
  }

  const evalDenied = await recordEvaluation({ orgId, membership: member, actorEmail: "x@example.com", modelId: reg.model.modelId, metrics: { accuracy: 0.9 } });
  assert.equal(evalDenied.status, 403);
  const ev = await recordEvaluation({ orgId, membership: owner, actorEmail: "owner@example.com", modelId: reg.model.modelId, metrics: { accuracy: 0.91, f1: 0.88, falsePositiveRate: 0.04 }, notes: "held-out test set, n=500" });
  assert.ok(!ev.error, JSON.stringify(ev));
  assert.equal(Object.keys(ev.evaluation.metrics).length, 3, "multiple named metrics, never collapsed into one score");

  const { models } = await listModels({ orgId, modelName: "risk-classifier" });
  assert.equal(models.length, 1);
});

test("evidence graph: the model version is a subject with DERIVED_FROM (dataset) and CHECKED_BY (evaluation) relationships", async () => {
  await flushEvidence();
  const events = await listBusinessEvents({ orgId, membership: owner, subjectType: "ML_STUDIO_MODEL" });
  assert.equal(events.length, 1);
  const rels = events[0].relationships.map((r) => r.type);
  assert.ok(rels.includes("DERIVED_FROM"), "the model's dataset lineage should be a real relationship");
  assert.ok(rels.includes("CHECKED_BY"), "the evaluation run should be a real relationship");
});

test("security hardening: downloadArtifact returns the exact original bytes, scoped by org+id together", async () => {
  const m = await getModel({ orgId, modelId });
  assert.ok(m, "the model must resolve within its own org");
  const f = await downloadArtifact({ orgId, modelId });
  assert.ok(!f.error, JSON.stringify(f));
  assert.equal(Buffer.compare(f.buffer, artifactBytes), 0, "the downloaded bytes must exactly match what was registered");
  assert.equal(f.filename, "model.bin");
  const wrongOrg = await getModel({ orgId: "000000000000000000000000", modelId });
  assert.equal(wrongOrg, null, "a different orgId must never resolve this model, even with the real modelId");
});
