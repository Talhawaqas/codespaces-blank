// scripts/db-restore.mjs
//
// Restores records from a daily database backup (src/lib/dbBackup.js). INSERT-ONLY: a record is added
// back only if no record with the same _id exists, so running it never overwrites or deletes anything.
//
//   node --env-file=.env.local scripts/db-restore.mjs --list
//       lists the backups (newest last) from the _meta record
//   node --env-file=.env.local scripts/db-restore.mjs <backup-pathname-or-url> --collections orgs,org_members
//       DRY RUN: shows how many records would be added back to those collections
//   ... add --apply to write them. Use --collections all for every collection.
//
// Needs MONGODB_URI, BLOB_READ_WRITE_TOKEN and DB_BACKUP_ENCRYPTION_KEY (the same key the backups were made with).

import { MongoClient, BSON } from "mongodb";
import { readBackup } from "../src/lib/dbBackup.js";

const { EJSON } = BSON;
const args = process.argv.slice(2);
const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("inaya_network_corporate");

try {
  if (args.includes("--list")) {
    const meta = await db.collection("_meta").findOne({ _id: "dbBackups" });
    for (const r of meta?.runs || []) console.log(`${r.takenAt}  ${r.collections} collections  ${r.documents} records  orgs=${r.orgs}  ${r.pathname}`);
  } else {
    const url = args.find((a) => a.startsWith("http") || a.startsWith("db-backups/"));
    const colArg = args[args.indexOf("--collections") + 1];
    if (!url || !colArg || args.indexOf("--collections") < 0) throw new Error("Usage: db-restore.mjs <backup-pathname-or-url> --collections <a,b|all> [--apply]");
    const wanted = colArg === "all" ? null : new Set(colArg.split(","));
    const apply = args.includes("--apply");
    const lines = (await readBackup(url)).split("\n").filter(Boolean);
    const byCol = new Map();
    for (const line of lines) {
      const { c, d } = JSON.parse(line);
      if (wanted && !wanted.has(c)) continue;
      if (!byCol.has(c)) byCol.set(c, []);
      byCol.get(c).push(EJSON.deserialize(d, { relaxed: false }));
    }
    for (const [name, docs] of byCol) {
      const existing = new Set((await db.collection(name).find({ _id: { $in: docs.map((d) => d._id) } }, { projection: { _id: 1 } }).toArray()).map((d) => EJSON.stringify(d._id)));
      const missing = docs.filter((d) => !existing.has(EJSON.stringify(d._id)));
      if (apply && missing.length) await db.collection(name).insertMany(missing, { ordered: false });
      console.log(`${name}: ${docs.length} in backup, ${missing.length} missing now${apply ? `, ${missing.length} added back` : " (dry run)"}`);
    }
    if (!apply) console.log("Dry run: nothing written. Add --apply to restore.");
  }
} finally {
  await client.close();
}
