// scripts/setup-odbc-verification-fixture.mjs
//
// One-off, LOCAL-ONLY script to stand up a real, persistent org + data
// source + published schema + API key, so odbc-driver/register-driver.ps1
// has something genuine to register and verify against. Mirrors
// test/legacy-data-access.test.mjs's own fixture helpers exactly, minus
// the test suite's automatic cleanup -- this fixture is meant to stick
// around for a real Driver-Manager-mediated ODBC connection to use.
//
// Run: node --env-file=.env.local scripts/setup-odbc-verification-fixture.mjs

import path from "node:path";
import { ObjectId } from "mongodb";
import { DatabaseSync } from "node:sqlite";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { registerDataSource } from "../src/lib/legacyDataAccess/dataSources.js";
import { importAndPublishSchema } from "../src/lib/legacyDataAccess/metadata.js";
import { createApiKey } from "../src/lib/api-keys.js";

await ensureOrgIndexes();
const collections = await getOrgCollections();

const orgId = new ObjectId();
await collections.orgs.insertOne({ _id: orgId, name: "odbc-verification-fixture", createdAt: new Date().toISOString() });
const membership = { role: "member", dataSourceRole: "manager", email: "odbc-verification@example.com" };

const filePath = path.resolve(process.cwd(), "scripts", "odbc-verification-fixture.sqlite");
const db = new DatabaseSync(filePath);
db.exec(`
  DROP TABLE IF EXISTS customers;
  CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT);
`);
db.prepare("INSERT INTO customers (id, name, region) VALUES (?, ?, ?)").run(1, "Acme Corp", "US");
db.prepare("INSERT INTO customers (id, name, region) VALUES (?, ?, ?)").run(2, "Globex", "EU");
db.close();

const { dataSource } = await registerDataSource({
  orgId: orgId.toString(),
  name: "ODBC verification fixture",
  connectorType: "relational",
  credentials: { filePath },
  membership,
  actorEmail: membership.email,
});
if (!dataSource) throw new Error("registerDataSource failed -- see above.");

await importAndPublishSchema({ orgId: orgId.toString(), dataSourceId: dataSource._id, membership, actorEmail: membership.email });

const { rawKey } = await createApiKey({ orgId: orgId.toString(), label: "odbc-verification", actorEmail: membership.email });

console.log("ORG_ID=" + orgId.toString());
console.log("DATA_SOURCE_ID=" + dataSource._id.toString());
console.log("API_KEY=" + rawKey);
console.log("SQLITE_FIXTURE=" + filePath);
console.log("Table available for the ODBC test query: customers (id, name, region)");

const client = await mongoClientPromise;
await client.close();
