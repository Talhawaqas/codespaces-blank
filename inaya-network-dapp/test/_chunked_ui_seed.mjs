// Seeds a throwaway company on the TEST database for the chunked-upload browser check, prints its ids and a session.
// Run: $env:INAYA_USE_TEST_DB="1"; node --env-file=.env.local --import ./test/_next-loader.mjs test/_chunked_ui_seed.mjs [cleanup <orgId>]
import { getOrgCollections, ensureOrgIndexes, createSession, SESSION_COOKIE } from "../src/lib/orgs.js";
import { purgeOrgObjects } from "../src/lib/s3-compat/purge.js";
import { ObjectId } from "mongodb";
await ensureOrgIndexes();
const c = await getOrgCollections();
if (process.argv[2] === "cleanup") {
  const orgId = new ObjectId(process.argv[3]);
  console.log("purged", JSON.stringify(await purgeOrgObjects(orgId)));
  for (const col of ["orgDocuments", "projects", "departments", "orgMembers", "orgActivity"]) await c[col].deleteMany({ orgId });
  await c.orgs.deleteMany({ _id: orgId });
  console.log("cleaned", String(orgId));
  process.exit(0);
}
const now = new Date().toISOString();
const run = Date.now().toString(36);
const email = `chunked-ui-${run}@example.com`;
const orgId = new ObjectId();
await c.orgs.insertOne({ _id: orgId, name: `Chunked UI ${run}`, ownerEmail: email, createdAt: now });
const departmentId = (await c.departments.insertOne({ orgId, name: "Operations", createdAt: now })).insertedId;
const projectId = (await c.projects.insertOne({ orgId, departmentId, name: "Large files", createdAt: now, memberEmails: [email] })).insertedId;
await c.orgMembers.insertOne({ orgId, email, role: "owner", status: "active", departmentIds: [departmentId], createdAt: now });
const { sessionToken } = await createSession(email);
console.log("SEED " + JSON.stringify({ orgId: String(orgId), departmentId: String(departmentId), projectId: String(projectId), email, cookie: SESSION_COOKIE, token: sessionToken }));
process.exit(0);
