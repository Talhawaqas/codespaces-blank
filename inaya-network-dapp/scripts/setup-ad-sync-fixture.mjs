// scripts/setup-ad-sync-fixture.mjs
//
// Creates a real, persistent org + AD identity provider record so the
// real AD sync agent (ad-sync-agent/) has a genuine providerId +
// signing secret to authenticate against, and prints the exact env vars
// to run the agent with.
//
// Run: node --env-file=.env.local scripts/setup-ad-sync-fixture.mjs

import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createProvider } from "../src/lib/identity/providers.js";

await ensureOrgIndexes();
const collections = await getOrgCollections();

const orgId = new ObjectId();
await collections.orgs.insertOne({ _id: orgId, name: "ad-sync-verification-fixture", createdAt: new Date().toISOString() });

const result = await createProvider({
  orgId: orgId.toString(),
  kind: "ad",
  providerTenantId: "inayatest.local",
  name: "inayatest.local (real test DC)",
  policy: {},
  actorEmail: "ad-sync-verification@example.com",
});

if (result.error) {
  console.error("createProvider failed:", result.error);
  process.exit(1);
}

console.log("ORG_ID=" + orgId.toString());
console.log("PROVIDER_ID=" + result.provider.providerId);
console.log("SIGNING_SECRET=" + result.signingSecret);

const client = await mongoClientPromise;
await client.close();
