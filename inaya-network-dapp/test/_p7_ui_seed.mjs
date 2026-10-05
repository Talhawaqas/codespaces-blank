// test/_p7_ui_seed.mjs -- throwaway org with device control, ransomware signals and endpoint backup ON, plus one raised signal and one backup profile with a run.
//   node --env-file=.env.local test/_p7_ui_seed.mjs
import { setup, teardown, makeChatOrg, cookieFor } from "./_chat-fixtures.mjs";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as R from "../src/lib/ransomware/cloud.js";
import * as B from "../src/lib/endpoint/backup.js";

await setup();
const org = await makeChatOrg("p7ui", { people: ["bob"] });
for (const f of ["FEATURE_DEVICE_CONTROL", "FEATURE_RANSOMWARE_SIGNALS", "FEATURE_ENDPOINT_BACKUP_V2"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
const actor = "AKIADEMOCREDENTIAL";
for (let i = 0; i < 8; i++) await R.noteActivity({ orgId: org.oid, actorKey: actor, kind: "overwrite", bucket: "docs", key: `report-${i}.docx`, entropy: 7.9, prevEntropy: 4 });
for (let i = 0; i < 20; i++) await R.noteActivity({ orgId: org.oid, actorKey: actor, kind: "overwrite", bucket: "docs", key: `sheet-${i}.xlsx`, entropy: 5, prevEntropy: 5 });
const p = await B.createProfile({ orgId: org.oid, email: org.owner.email, membership: org.owner.membership, input: { name: "Documents", folders: [{ path: "C:\Users\me\Documents" }], schedule: { mode: "interval", everyMinutes: 60 }, retention: { versions: 30 }, bucket: "endpoint-backups", prefix: "me/" } });
await B.reportRun({ orgId: org.oid, email: org.owner.email, report: { profileId: p.profileId, status: "ok", files: { scanned: 120, changed: 7, uploaded: 7, bytes: 40960 } } });
console.log("SEED " + JSON.stringify({ orgId: org.oid, ownerToken: await cookieFor(org.owner.email) }));
const stop = async () => { try { await teardown(); } catch {} process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop); setTimeout(stop, 30 * 60_000); setInterval(() => {}, 1e6);
