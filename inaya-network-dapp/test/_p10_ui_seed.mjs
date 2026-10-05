// test/_p10_ui_seed.mjs -- throwaway organization for the Phase 10 browser pass (compliance readiness, government profile, keys). Prints SEED {...}; runs until killed.
//   node --env-file=.env.local test/_p10_ui_seed.mjs
import { randomBytes } from "node:crypto";
import { setup, teardown, makeChatOrg, cookieFor, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as IMPL from "../src/lib/compliance/implementation.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";

process.env.CMK_LOCAL_KEYS = process.env.CMK_LOCAL_KEYS || JSON.stringify({ "cust-2026": randomBytes(32).toString("base64") });
await setup(); const db = (await getOrgCollections()).db; const org = await makeChatOrg("p10ui", { people: ["auditor"] });
for (const f of ["FEATURE_COMPLIANCE_READINESS", "FEATURE_GOVERNMENT_SECURITY_PROFILE", "FEATURE_CUSTOMER_MANAGED_KEYS"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
await cols.orgMembers.updateOne({ orgId: org.orgId, email: org.auditor.email }, { $set: { adminRoles: ["auditor"] } });
const o = { orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email };
await IMPL.updateControl({ ...o, controlId: "AT-2", patch: { implementation: "implemented", responsibility: "customer", ownerEmail: org.owner.email, statement: "Annual security awareness training run by HR." } });
await IMPL.attachEvidence({ ...o, controlId: "AT-2", ref: { kind: "link", url: "https://hr.example.com/training-2026.pdf", label: "2026 training record" } });
await IMPL.updateControl({ ...o, controlId: "PL-4", patch: { implementation: "implemented" } });
await ensureOwnerS3Passphrase({ type: "org", orgId: org.oid });
console.log("SEED " + JSON.stringify({ orgId: org.oid, ownerToken: await cookieFor(org.owner.email), auditorToken: await cookieFor(org.auditor.email), localKeys: Object.keys(JSON.parse(process.env.CMK_LOCAL_KEYS)) }));
const stop = async () => { try { for (const n of ["compliance_control_status", "compliance_snapshots", "gov_security_profile", "org_key_config", "org_key_audit", "data_classifications"]) await db.collection(n).deleteMany({ orgId: org.orgId }); await db.collection("s3_owner_keys").deleteMany({ ownerId: org.oid }); await teardown(); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop); setTimeout(stop, 40 * 60_000); setInterval(() => {}, 1e6);
