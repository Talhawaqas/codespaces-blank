// src/lib/rds/db.js -- collections and indexes, same shape as every other feature's db.js in this codebase.
import { connectToDatabase } from "../mongodb.js";

const NAMES = { rdsInstances: "rds_instances", rdsOperations: "rds_operations" };

export async function getRdsCollections() {
  const { db } = await connectToDatabase();
  const out = { db };
  for (const [k, n] of Object.entries(NAMES)) out[k] = db.collection(n);
  return out;
}

let ensured = false;
export async function ensureRdsIndexes() {
  if (ensured) return;
  const c = await getRdsCollections();
  await Promise.all([
    c.rdsInstances.createIndex({ orgId: 1, name: 1 }, { unique: true }),
    c.rdsInstances.createIndex({ orgId: 1, status: 1 }),
    c.rdsOperations.createIndex({ orgId: 1, instanceId: 1, createdAt: -1 }),
  ]);
  ensured = true;
}
