// scripts/demo/resilience/attack-cloud.mjs -- the controlled, ransomware-LIKE simulation against the demo bucket (SOW Workstream B,
// Stage 2). NOT malware: it uses the compromised account's own S3 credential against the REAL S3-compatible API of the demo server
// (http://127.0.0.1:3003/api/s3), exactly as a sync client on an infected laptop would, and only ever touches the demo bucket.
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/attack-cloud.mjs                 # scenario A
//   node --env-file=.env.local --import ./test/_next-loader.mjs scripts/demo/resilience/attack-cloud.mjs --scenario decoy # scenario B
// Scenario A (business folders): drops a ransom-note-named file, then rewrites each business document with random bytes
// (encryption-like content) and writes a ".locked" copy, file by file, until the platform refuses; then shows that reading
// still works and that deleting is refused too. Scenario B (decoy): a second credential's first action rewrites the hidden
// tripwire file. Every request and its real HTTP result is printed and saved to evidence/attack-cloud-<time>.log.
import "./_env.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DEMO_EVIDENCE_DIR } from "./_env.mjs";
import { DEMO_URL, BUCKET, COMPROMISED, RANSOM_NOTE_NAME, RANSOM_NOTE, encryptedLike, loadState, saveState, stamp } from "./_common.mjs";

const scenario = process.argv.includes("--scenario") ? process.argv[process.argv.indexOf("--scenario") + 1] : "business";
const state = loadState();
if (!state.orgId || !state.samAccessKeyId) { console.error("Seed the demo first (reset.mjs)."); process.exit(1); }
let accessKeyId = state.samAccessKeyId, secretAccessKey = state.samSecretAccessKey, label = `${COMPROMISED.name} - laptop sync`;
if (scenario === "decoy") {
  const { issueS3Credential } = await import("../../../src/lib/s3-compat/credentials.js");
  const k = state.decoyAccessKeyId ? { accessKeyId: state.decoyAccessKeyId, secretAccessKey: state.decoySecretAccessKey } : await issueS3Credential({ owner: { type: "org", orgId: state.orgId }, label: "Scanner workstation - sync", actorEmail: "alex.morgan@northwind.example" });
  saveState({ decoyAccessKeyId: k.accessKeyId, decoySecretAccessKey: k.secretAccessKey });
  ({ accessKeyId, secretAccessKey } = k); label = "Scanner workstation - sync";
}
const s3 = new S3Client({ endpoint: `${DEMO_URL}/api/s3`, forcePathStyle: true, region: "us-east-1", credentials: { accessKeyId, secretAccessKey } });
const out = [];
const say = (line) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${line}`; out.push(l); console.log(l); };
async function call(desc, cmd) {
  try { const r = await s3.send(cmd); say(`${desc}  ->  ${r.$metadata.httpStatusCode} OK`); return { ok: true, r }; }
  catch (e) { const st = e.$metadata?.httpStatusCode || "ERR"; const why = /paused/i.test(e.message || "") ? "writes from this credential are paused" : (e.message || e.name).slice(0, 70); say(`${desc}  ->  ${st} REFUSED (${why})`); return { ok: false, status: st }; }
}

say(`SIMULATION (synthetic, no malware) - scenario ${scenario} - credential ${accessKeyId} (${label}) - bucket ${BUCKET}`);
const list = await call("LIST    bucket", new ListObjectsV2Command({ Bucket: BUCKET }));
const keys = (list.r?.Contents || []).map((o) => o.Key);
say(`        found ${keys.length} files`);
let changed = [], refused = [];
if (scenario === "decoy") {
  const decoy = keys.find((k) => k.startsWith(".inaya-canary/"));
  if (!decoy) { say("No tripwire file in this bucket; scenario B needs one."); process.exit(1); }
  const r = await call(`WRITE   ${decoy} (encryption-like)`, new PutObjectCommand({ Bucket: BUCKET, Key: decoy, Body: encryptedLike(2048) }));
  if (r.ok) changed.push(decoy);
  const next = keys.find((k) => !k.startsWith("."));
  const r2 = await call(`WRITE   ${next} (encryption-like)`, new PutObjectCommand({ Bucket: BUCKET, Key: next, Body: encryptedLike() }));
  (r2.ok ? changed : refused).push(next);
} else {
  const note = await call(`WRITE   ${RANSOM_NOTE_NAME} (ransom-note style name)`, new PutObjectCommand({ Bucket: BUCKET, Key: RANSOM_NOTE_NAME, Body: RANSOM_NOTE }));
  if (!note.ok) refused.push(RANSOM_NOTE_NAME);
  for (const key of keys.filter((k) => !k.startsWith(".") && k !== RANSOM_NOTE_NAME)) {
    const w = await call(`WRITE   ${key} (encryption-like rewrite)`, new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: encryptedLike() }));
    if (!w.ok) { refused.push(key); continue; }
    changed.push(key);
    const l = await call(`WRITE   ${key}.locked`, new PutObjectCommand({ Bucket: BUCKET, Key: `${key}.locked`, Body: encryptedLike(1024) }));
    if (!l.ok) refused.push(`${key}.locked`);
  }
}
const readKey = keys.find((k) => !k.startsWith(".") && k !== RANSOM_NOTE_NAME);
const rd = await call(`READ    ${readKey}`, new GetObjectCommand({ Bucket: BUCKET, Key: readKey }));
if (rd.ok) await rd.r.Body.transformToByteArray();
await call(`DELETE  ${readKey}`, new DeleteObjectCommand({ Bucket: BUCKET, Key: readKey }));
say(`RESULT  ${changed.length} file(s) changed before the pause, ${refused.length} write(s) refused, reads ${rd.ok ? "still work" : "failed"}`);
const file = path.join(DEMO_EVIDENCE_DIR, `attack-cloud-${scenario}-${stamp().replace(/[:.]/g, "-")}.log`);
writeFileSync(file, out.join("\n") + "\n");
saveState({ [`lastCloudAttack_${scenario}`]: { at: stamp(), credential: accessKeyId, changed, refused, log: file } });
console.log("Saved:", file);
process.exit(0);
