// test/_gov_ui_seed.mjs -- throwaway org with Advanced sharing ON and one document, for a real-browser pass. Prints SEED, runs until killed/MAX_MIN, cleans up.
//   node --env-file=.env.local test/_gov_ui_seed.mjs
import { randomBytes } from "node:crypto";
import { setup, teardown, makeChatOrg, cookieFor, c } from "./_chat-fixtures.mjs";
import { setOrgFeature } from "../src/lib/featureFlags.js";

await setup();
const org = await makeChatOrg("govui", { people: ["bob"] });
for (const f of ["FEATURE_ADVANCED_SHARING", "FEATURE_FILE_GOVERNANCE", "FEATURE_DLP", "FEATURE_SMART_CLASSIFICATION"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
const now = new Date().toISOString();
const dep = (await c.departments.insertOne({ orgId: org.orgId, name: "Legal", createdAt: now })).insertedId;
const prj = (await c.projects.insertOne({ orgId: org.orgId, departmentId: dep, name: "Contracts", createdAt: now })).insertedId;
await c.orgDocuments.insertOne({ orgId: org.orgId, departmentId: dep, projectId: prj, filename: "payroll-2026.xlsx", fileHash: `0xs-${randomBytes(4).toString("hex")}`, sizeBytes: 999, cidAlpha: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", cidBeta: "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", uploadedByEmail: org.owner.email, txHash: "0xfake", status: "DRAFT", accessLevel: "PRIVATE", createdAt: now, deletedAt: null });
console.log("SEED " + JSON.stringify({ orgId: org.oid, ownerEmail: org.owner.email, ownerToken: await cookieFor(org.owner.email) }));
const stop = async () => { try { await teardown(); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
setTimeout(stop, (Number(process.env.MAX_MIN) || 25) * 60_000);
setInterval(() => {}, 1e6);
