// scripts/demo/resilience/safety-check.mjs -- the environment safety checklist (SOW sections 5.A.3 and 8). Run before every
// rehearsal, recording or live demonstration; every line must say PASS.
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/safety-check.mjs
// It asks the application's own code (not just the settings) whether production can be reached.
import "./_env.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DEMO_EVIDENCE_DIR, DEMO_STORAGE_DIR, PROD_DB_HOST, TEST_DB_HOST, DISABLED } from "./_env.mjs";
import { DEMO_ORG_ID, DEMO_URL, ADMIN, COMPROMISED, stamp } from "./_common.mjs";
import { getOrgCollections } from "../../../src/lib/orgs.js";
import * as filebase from "../../../src/lib/pinningProviders/filebase.js";
import * as pinata from "../../../src/lib/pinningProviders/pinata.js";
import { localPinDir } from "../../../src/lib/pinningProviders/testGuard.js";
import { ObjectId } from "mongodb";

const host = (uri) => { try { return new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).hostname; } catch { return "unparseable"; } };
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, result: ok ? "PASS" : "FAIL", detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -  " + detail : ""}`); };

const { db, orgs, orgMembers } = await getOrgCollections();
check("Database is the TEST cluster", process.env.MONGODB_URI === process.env.TEST_MONGODB_URI && host(process.env.MONGODB_URI) === TEST_DB_HOST, "connected to the test cluster");
check("Test cluster is a different cluster from production", !!TEST_DB_HOST && !!PROD_DB_HOST && TEST_DB_HOST !== PROD_DB_HOST, TEST_DB_HOST === PROD_DB_HOST ? "same host!" : "different hosts");
check("Filebase (production file storage) unreachable", !filebase.isConfigured(), "provider reports itself unconfigured");
check("Pinata (fallback file storage) unreachable", !pinata.isConfigured(), "provider reports itself unconfigured");
check("Files are stored in the demo's local folder only", localPinDir() === DEMO_STORAGE_DIR, DEMO_STORAGE_DIR);
check("E-mail cannot be sent", [process.env.RESEND_API_KEY, process.env.RESEND_MARKETING_API_KEY, process.env.RESEND_INBOUND_API_KEY].every((k) => k === DISABLED), "Resend keys are a placeholder; any send fails authentication");
check("Demo server listens on this computer only", new URL(DEMO_URL).hostname === "127.0.0.1", DEMO_URL);
const org = await orgs.findOne({ _id: new ObjectId(DEMO_ORG_ID) });
check("Demo company is synthetic", !!org && /\(Demo\)$/.test(org.name), org ? org.name : "not seeded yet");
const members = await orgMembers.find({ orgId: new ObjectId(DEMO_ORG_ID) }).project({ email: 1 }).toArray();
check("Demo people use the reserved .example domain", members.length > 0 && members.every((m) => m.email.endsWith(".example")), members.map((m) => m.email).join(", ") || "not seeded yet");
check("Simulation targets only the demo company", [ADMIN.email, COMPROMISED.email].every((e) => e.endsWith(".example")), "attack scripts use the demo credential and bucket from the seed state");
const realOrgsTouched = await db.collection("orgs").countDocuments({ _id: new ObjectId(DEMO_ORG_ID) });
check("Exactly one demo company in the test database", realOrgsTouched === 1, `${realOrgsTouched}`);

const file = path.join(DEMO_EVIDENCE_DIR, `safety-checklist-${stamp().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ checkedAt: stamp(), checks }, null, 2));
const failed = checks.filter((c) => c.result === "FAIL").length;
console.log(failed ? `\n${failed} check(s) FAILED - do not run the demonstration.` : "\nAll checks passed.", "Saved:", file);
process.exit(failed ? 1 : 0);
