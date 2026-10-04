// test/external-tools-e2e.test.mjs -- the real command-line tools customers already use (rclone for S3, AzCopy for Azure Blob), run as
// real processes against the running dev server with a disposable org + credential that this test creates and removes.
// Skipped (not failed) for a tool that is not installed or when no dev server answers on http://localhost:3000.
// Run: node --env-file=.env.local --test --test-force-exit --test-concurrency=1 test/external-tools-e2e.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, ensureOwnerS3Passphrase, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { signServiceSas } from "../src/lib/s3-compat/azureSas.js";
import { purgeOrgObjects } from "../src/lib/s3-compat/purge.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN = randomUUID().slice(0, 8);
const SERVER = "http://localhost:3000";
const S3 = `${SERVER}/api/s3`;
const AZ = "http://azure.127.0.0.1.sslip.io:3000"; // host-based Azure addressing (AZURE_COMPAT_HOST_BASE), the form AzCopy expects
let c, orgId, cred, work, up = false;
const have = (cmd) => spawnSync(cmd, ["--version"], { shell: true, encoding: "utf8" }).status === 0 || spawnSync(cmd, ["version"], { shell: true, encoding: "utf8" }).status === 0;
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const run = (cmd, args, env = {}, cwd = work) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 }); return { status: r.status, stdout: r.stdout, out: `${r.stdout}\n${r.stderr}` }; };

before(async () => {
  up = await fetch(`${SERVER}/api/bridge/supported-chains`).then((r) => r.ok).catch(() => false);
  if (!up) return;
  await ensureOrgIndexes(); c = await getOrgCollections(); await ensureS3CompatIndexes(c.db);
  orgId = new ObjectId();
  await c.orgs.insertOne({ _id: orgId, name: `tools-e2e-${RUN}`, createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  cred = await issueS3Credential({ owner: { type: "org", orgId: String(orgId) }, label: "tools e2e", actorEmail: "t@example.com" });
  work = fs.mkdtempSync(path.join(os.tmpdir(), "tools-e2e-"));
  fs.mkdirSync(path.join(work, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(work, "src", "hello.txt"), "hello from a real command-line tool\n");
  fs.writeFileSync(path.join(work, "src", "nested", "data.bin"), randomBytes(300_000));
  fs.writeFileSync(path.join(work, "src", "big.bin"), randomBytes(12 * 1024 * 1024 + 4321)); // forces multipart
});

after(async () => {
  if (orgId) {
    await purgeOrgObjects(orgId).catch(() => {});
    await Promise.all([c.orgs.deleteMany({ _id: orgId }), c.departments.deleteMany({ orgId }), c.projects.deleteMany({ orgId }), c.orgDocuments.deleteMany({ orgId }), c.orgActivity.deleteMany({ orgId }),
      c.db.collection("s3_credentials").deleteMany({ ownerId: String(orgId) }), c.db.collection("s3_owner_keys").deleteMany({ ownerId: String(orgId) })]);
  }
  if (work && !process.env.KEEP_WORK) fs.rmSync(work, { recursive: true, force: true });
  else if (work) console.log("kept work dir:", work);
  await (await mongoClientPromise).close();
});

// ------------------------------------------------------------------------------------------------ rclone
const rcloneEnv = () => ({
  RCLONE_CONFIG_INAYA_TYPE: "s3", RCLONE_CONFIG_INAYA_PROVIDER: "Other", RCLONE_CONFIG_INAYA_ENDPOINT: S3, RCLONE_CONFIG_INAYA_ACCESS_KEY_ID: cred.accessKeyId,
  RCLONE_CONFIG_INAYA_SECRET_ACCESS_KEY: cred.secretAccessKey, RCLONE_CONFIG_INAYA_FORCE_PATH_STYLE: "true", RCLONE_CONFIG_INAYA_REGION: "inaya",
  RCLONE_CONFIG_INAYA_NO_CHECK_BUCKET: "false", RCLONE_CONFIG: path.join(work, "no-config.conf"),
});

test("rclone: make bucket, copy a tree (incl. a multipart file), list, verify, download back byte-for-byte", (t) => {
  if (!up) return t.skip("no dev server"); if (!have("rclone")) return t.skip("rclone is not installed");
  const bucket = `rc-${RUN}`; const env = rcloneEnv();
  let r = run("rclone", ["mkdir", `inaya:${bucket}`], env); assert.equal(r.status, 0, r.out);
  r = run("rclone", ["copy", "src", `inaya:${bucket}/data`, "--s3-chunk-size", "5M", "--s3-upload-cutoff", "5M", "--s3-upload-concurrency", "2", "-v"], env); assert.equal(r.status, 0, r.out.slice(-1500));
  r = run("rclone", ["lsf", "-R", `inaya:${bucket}`], env); assert.equal(r.status, 0, r.out);
  for (const f of ["data/hello.txt", "data/nested/data.bin", "data/big.bin"]) assert.ok(r.out.includes(f), `${f} listed:\n${r.out}`);
  r = run("rclone", ["check", "src", `inaya:${bucket}/data`, "--size-only"], env); assert.equal(r.status, 0, "sizes match: " + r.out.slice(-800));
  fs.rmSync(path.join(work, "back"), { recursive: true, force: true });
  r = run("rclone", ["copy", `inaya:${bucket}/data`, "back", "--s3-chunk-size", "5M"], env); assert.equal(r.status, 0, r.out.slice(-1500));
  for (const f of ["hello.txt", path.join("nested", "data.bin"), "big.bin"]) assert.equal(sha(path.join(work, "back", f)), sha(path.join(work, "src", f)), `${f} came back identical`);
});

test("rclone: ranged read, sync (changed + removed files), and delete", (t) => {
  if (!up) return t.skip("no dev server"); if (!have("rclone")) return t.skip("rclone is not installed");
  const bucket = `rc-${RUN}`; const env = rcloneEnv();
  let r = run("rclone", ["cat", `inaya:${bucket}/data/hello.txt`, "--offset", "6", "--count", "4"], env); assert.equal(r.status, 0, r.out); assert.equal(r.stdout.trim().slice(0, 4), "from", "a byte-range read returns just that range: " + JSON.stringify(r.out));
  fs.writeFileSync(path.join(work, "src", "hello.txt"), "hello again, changed content\n"); fs.rmSync(path.join(work, "src", "nested"), { recursive: true });
  r = run("rclone", ["sync", "src", `inaya:${bucket}/data`, "--s3-chunk-size", "5M", "--s3-upload-cutoff", "5M"], env); assert.equal(r.status, 0, r.out.slice(-1500));
  r = run("rclone", ["lsf", "-R", `inaya:${bucket}`], env);
  assert.ok(!r.out.includes("nested/data.bin"), "sync removed the file deleted locally:\n" + r.out);
  r = run("rclone", ["cat", `inaya:${bucket}/data/hello.txt`], env); assert.equal(r.stdout.trim(), "hello again, changed content", "sync updated the changed file");
  r = run("rclone", ["purge", `inaya:${bucket}`], env); assert.equal(r.status, 0, r.out);
  r = run("rclone", ["lsd", "inaya:"], env); assert.ok(!r.out.includes(bucket), "bucket gone after purge:\n" + r.out);
});

test("rclone: a wrong secret is refused", (t) => {
  if (!up) return t.skip("no dev server"); if (!have("rclone")) return t.skip("rclone is not installed");
  const r = run("rclone", ["lsd", "inaya:"], { ...rcloneEnv(), RCLONE_CONFIG_INAYA_SECRET_ACCESS_KEY: "definitely-not-the-secret" });
  assert.notEqual(r.status, 0); assert.match(r.out, /403|SignatureDoesNotMatch|AccessDenied|Forbidden/i);
});

// ------------------------------------------------------------------------------------------------ AzCopy
test("AzCopy: upload a tree (incl. a large blob) with a share link, list, download back byte-for-byte, sync, remove", (t) => {
  if (!up) return t.skip("no dev server"); if (!have("azcopy")) return t.skip("azcopy is not installed");
  const container = `az-${RUN}`; const keyB64 = Buffer.from(cred.secretAccessKey, "utf8").toString("base64");
  const sas = signServiceSas({ accountName: cred.accessKeyId, accountKeyBase64: keyB64, container, permissions: "racwdl", expiresAt: Date.now() + 3600_000 });
  const url = `${AZ}/${container}?${sas}`; const sub = (p) => `${AZ}/${container}/${p}?${sas}`;
  const env = { AZCOPY_AUTO_LOGIN_TYPE: "", AZCOPY_DISABLE_SYSLOG: "true", AZCOPY_LOG_LOCATION: path.join(work, "azlog"), AZCOPY_JOB_PLAN_LOCATION: path.join(work, "azplan") };
  let r = run("azcopy", ["make", url], env);
  // `make` on a container that the endpoint creates on first write may report either; the upload below is the real proof
  r = run("azcopy", ["copy", path.join(work, "src") + path.sep + "*", url, "--recursive", "--from-to", "LocalBlob", "--block-size-mb", "4", "--output-type", "text"], env); assert.equal(r.status, 0, r.out.slice(-2500));
  assert.match(r.out, /Number of File Transfers: 3[\s\S]*Final Job Status: Completed|Final Job Status: Completed/, r.out.slice(-1500));
  r = run("azcopy", ["list", url, "--location", "Blob", "--output-type", "text"], env); assert.equal(r.status, 0, r.out.slice(-1500));
  for (const f of ["hello.txt", "nested/data.bin", "big.bin"]) assert.ok(r.out.includes(f), `${f} listed:\n${r.out}`);
  fs.rmSync(path.join(work, "azback"), { recursive: true, force: true }); fs.mkdirSync(path.join(work, "azback"));
  r = run("azcopy", ["copy", url + "", path.join(work, "azback"), "--recursive", "--from-to", "BlobLocal", "--output-type", "text"], env); assert.equal(r.status, 0, r.out.slice(-2500));
  const root = fs.existsSync(path.join(work, "azback", container)) ? path.join(work, "azback", container) : path.join(work, "azback");
  for (const f of ["hello.txt", path.join("nested", "data.bin"), "big.bin"]) if (fs.existsSync(path.join(work, "src", f))) assert.equal(sha(path.join(root, f)), sha(path.join(work, "src", f)), `${f} came back identical`);
  r = run("azcopy", ["remove", sub("hello.txt"), "--from-to", "BlobTrash", "--output-type", "text"], env); assert.equal(r.status, 0, r.out.slice(-1500));
  r = run("azcopy", ["list", url, "--location", "Blob", "--output-type", "text"], env); assert.ok(!r.out.includes("hello.txt"), "the removed blob is gone:\n" + r.out);
});

test("AzCopy: a share link without write permission cannot upload; a tampered link is refused", (t) => {
  if (!up) return t.skip("no dev server"); if (!have("azcopy")) return t.skip("azcopy is not installed");
  const container = `az-${RUN}`; const keyB64 = Buffer.from(cred.secretAccessKey, "utf8").toString("base64");
  const env = { AZCOPY_AUTO_LOGIN_TYPE: "", AZCOPY_DISABLE_SYSLOG: "true", AZCOPY_LOG_LOCATION: path.join(work, "azlog2"), AZCOPY_JOB_PLAN_LOCATION: path.join(work, "azplan2") };
  const readOnly = signServiceSas({ accountName: cred.accessKeyId, accountKeyBase64: keyB64, container, permissions: "rl", expiresAt: Date.now() + 3600_000 });
  const f = path.join(work, "src", "big.bin");
  let r = run("azcopy", ["copy", f, `${AZ}/${container}/should-not-exist.bin?${readOnly}`, "--from-to", "LocalBlob", "--output-type", "text"], env);
  // The refusal must come from the SERVER (403), not from a network or routing failure: AzCopy's job log records the HTTP status of each request.
  const logs = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".log")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n") : "";
  assert.match(r.out + logs(path.join(work, "azlog2")), /403|AuthorizationPermissionMismatch/, "read-only link refused with a 403 by the server:\n" + r.out.slice(-1200));
  assert.doesNotMatch(r.out, /Final Job Status: Completed\b(?!With)/, "the upload must not have succeeded");
  const tampered = readOnly.replace(/sig=[^&]+/, "sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D");
  r = run("azcopy", ["list", `${AZ}/${container}?${tampered}`, "--location", "Blob", "--output-type", "text"], env);
  assert.match(r.out + logs(path.join(work, "azlog2")), /403|AuthenticationFailed/, "tampered link refused with a 403 by the server:\n" + r.out.slice(-1200));
});
