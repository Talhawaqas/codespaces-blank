// test/directsync-rust-e2e.test.mjs -- runs DirectSync's real Rust end-to-end test (resumable multipart upload, resume after an
// interruption, stale-state discard, "Create Secure Link") against a running dev server, with a disposable org + S3 credential that
// this test creates and removes. Skipped (not failed) when cargo or the dev server is unavailable.
// Needs: the dev server on http://localhost:3000 and a Rust toolchain.
// Run: node --env-file=.env.local --test --test-force-exit test/directsync-rust-e2e.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, ensureOwnerS3Passphrase, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { purgeOrgObjects } from "../src/lib/s3-compat/purge.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN = randomUUID().slice(0, 8);
const TAURI_DIR = path.resolve(process.cwd(), "..", "inaya-desktop", "src-tauri");
const SERVER = "http://localhost:3000";
import fs from "node:fs";
const await_import_fs = () => fs;
let collections, orgId, credential, skip = null;

before(async () => {
  if (spawnSync("cargo", ["--version"], { shell: true }).status !== 0) { skip = "cargo is not installed"; return; }
  const up = await fetch(`${SERVER}/api/bridge/supported-chains`).then((r) => r.ok).catch(() => false);
  if (!up) { skip = `no dev server at ${SERVER}`; return; }
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
  orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `ds-e2e-${RUN}`, createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  credential = await issueS3Credential({ owner: { type: "org", orgId: String(orgId) }, label: "directsync e2e", actorEmail: "t@example.com" });
});

after(async () => {
  if (orgId) {
    await purgeOrgObjects(orgId).catch(() => {});
    const { orgs, departments, projects, orgDocuments, orgActivity, db } = collections;
    await orgs.deleteMany({ _id: orgId }); await departments.deleteMany({ orgId }); await projects.deleteMany({ orgId });
    await orgDocuments.deleteMany({ orgId }); await orgActivity.deleteMany({ orgId });
    await db.collection("s3_credentials").deleteMany({ ownerId: String(orgId) });
    await db.collection("s3_owner_keys").deleteMany({ ownerId: String(orgId) });
  }
  await (await mongoClientPromise).close();
});

test("DirectSync (Rust): multipart upload, resume, stale-state discard and secure links work against the live endpoint", { timeout: 900_000 }, (t) => {
  if (skip) return t.skip(skip);
  const r = spawnSync("cargo", ["test", "--lib", "real_dev_server_resumable_multipart_and_secure_link", "--", "--ignored", "--nocapture"], {
    cwd: TAURI_DIR, encoding: "utf8", shell: true, timeout: 800_000,
    env: { ...process.env, DIRECTSYNC_TEST_ENDPOINT: `${SERVER}/api/s3`, DIRECTSYNC_TEST_ACCESS_KEY_ID: credential.accessKeyId, DIRECTSYNC_TEST_SECRET_ACCESS_KEY: credential.secretAccessKey, DIRECTSYNC_TEST_BUCKET: `ds-mp-${RUN}` },
  });
  const out = `${r.stdout}\n${r.stderr}`;
  const panic = (out.match(/panicked at[sS]{0,600}/) || [""])[0];
  if (r.status !== 0) { (await_import_fs()).writeFileSync(path.join(process.env.TEMP || "/tmp", "ds-e2e-last.out"), out); }
  assert.equal(r.status, 0, JSON.stringify(panic || out.slice(-3000)));
  assert.match(out, /multipart\/resume\/secure-link end-to-end test: PASSED/);
});
