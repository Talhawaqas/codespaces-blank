// One-off setup for a live ODBC smoke test: creates a real org, a real
// API key, and a real relational data source (against the same SQLite
// fixture the JDBC integration test used) via the actual library
// functions -- not mocked. Prints connection parameters for use with the
// direct-load ODBC test harness. Deleted/cleaned up after use.
import { MongoClient, ObjectId } from "mongodb";
import { DatabaseSync } from "node:sqlite";
import { registerDataSource } from "../../src/lib/legacyDataAccess/dataSources.js";
import { importAndPublishSchema } from "../../src/lib/legacyDataAccess/metadata.js";
import { createApiKey } from "../../src/lib/api-keys.js";
import { ensureOrgIndexes } from "../../src/lib/orgs.js";

const sqlitePath = process.env.TEMP + "\\odbc-driver-test.sqlite";
const db = new DatabaseSync(sqlitePath);
db.exec(`
  DROP TABLE IF EXISTS products;
  CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT NOT NULL, price REAL NOT NULL, in_stock INTEGER NOT NULL);
  INSERT INTO products (id, sku, price, in_stock) VALUES (1, 'ODBC-WIDGET-1', 12.50, 1);
  INSERT INTO products (id, sku, price, in_stock) VALUES (2, 'ODBC-WIDGET-2', 24.99, 0);
`);
db.close();

await ensureOrgIndexes();
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const dbh = client.db();

const now = new Date().toISOString();
const orgResult = await dbh.collection("orgs").insertOne({
  name: "ODBC Driver Test Org", createdAt: now, plan: "enterprise",
});
const orgId = orgResult.insertedId.toString();
const membership = { role: "owner" };

const apiKey = await createApiKey({ orgId, label: "odbc-driver-test", actorEmail: "odbc-test@inaya.local" });

const dsResult = await registerDataSource({
  orgId, name: "ODBC Test SQLite", connectorType: "relational",
  credentials: { filePath: sqlitePath }, membership, actorEmail: "odbc-test@inaya.local",
});
if (dsResult.error) { console.error("registerDataSource failed:", dsResult.error); process.exit(1); }

const publishResult = await importAndPublishSchema({
  orgId, dataSourceId: dsResult.dataSource._id.toString(), membership, actorEmail: "odbc-test@inaya.local",
});
if (publishResult.error) { console.error("importAndPublishSchema failed:", publishResult.error); process.exit(1); }

console.log(JSON.stringify({
  orgId,
  apiKey: apiKey.rawKey,
  dataSourceId: dsResult.dataSource._id.toString(),
  sqlitePath,
  tableCount: publishResult.tables.length,
}, null, 2));

await client.close();
