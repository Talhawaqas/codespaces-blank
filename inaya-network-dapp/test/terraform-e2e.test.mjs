// test/terraform-e2e.test.mjs -- real Terraform (the AWS provider, pointed at Inaya's S3 endpoint) managing a bucket and objects:
// init, plan, apply, a second plan with no changes (idempotent), an in-place update, a data-source read, and destroy.
// Uses a disposable org + credential created and removed here. Skipped when terraform is missing or no dev server answers.
// The first run downloads the AWS provider into a plugin cache (~/.terraform.d/plugin-cache).
// Run: node --env-file=.env.local --test --test-force-exit --test-concurrency=1 test/terraform-e2e.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, ensureOwnerS3Passphrase, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { purgeOrgObjects } from "../src/lib/s3-compat/purge.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN = randomUUID().slice(0, 8);
const SERVER = "http://localhost:3000";
let c, orgId, cred, dir, up = false, tf = false;
const cache = path.join(os.homedir(), ".terraform.d", "plugin-cache");
const run = (args, extra = {}) => { const r = spawnSync("terraform", args, { cwd: dir, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TF_IN_AUTOMATION: "1", TF_INPUT: "0", TF_PLUGIN_CACHE_DIR: cache, AWS_ACCESS_KEY_ID: cred.accessKeyId, AWS_SECRET_ACCESS_KEY: cred.secretAccessKey, ...extra } }); return { status: r.status, out: `${r.stdout}\n${r.stderr}` }; };

const config = (content) => `
terraform {
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }
}
provider "aws" {
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  skip_region_validation      = true
  s3_use_path_style           = true
  endpoints { s3 = "${SERVER}/api/s3" }
}
resource "aws_s3_bucket" "b" { bucket = "tf-${RUN}" }
resource "aws_s3_object" "greeting" {
  bucket       = aws_s3_bucket.b.bucket
  key          = "config/greeting.txt"
  content      = "${content}"
  content_type = "text/plain"
}
resource "aws_s3_object" "second" {
  bucket  = aws_s3_bucket.b.bucket
  key     = "config/second.json"
  content = jsonencode({ run = "${RUN}", ok = true })
}
data "aws_s3_object" "read_back" {
  bucket     = aws_s3_bucket.b.bucket
  key        = "config/greeting.txt"
  depends_on = [aws_s3_object.greeting]
}
output "read_back_body" { value = data.aws_s3_object.read_back.body }
`;

before(async () => {
  tf = spawnSync("terraform", ["version"], { shell: true }).status === 0;
  up = await fetch(`${SERVER}/api/bridge/supported-chains`).then((r) => r.ok).catch(() => false);
  if (!up || !tf) return;
  fs.mkdirSync(cache, { recursive: true });
  await ensureOrgIndexes(); c = await getOrgCollections(); await ensureS3CompatIndexes(c.db);
  orgId = new ObjectId();
  await c.orgs.insertOne({ _id: orgId, name: `tf-e2e-${RUN}`, createdAt: new Date().toISOString() });
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  cred = await issueS3Credential({ owner: { type: "org", orgId: String(orgId) }, label: "terraform e2e", actorEmail: "t@example.com" });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-e2e-"));
  fs.writeFileSync(path.join(dir, "main.tf"), config("hello from terraform"));
});

after(async () => {
  if (orgId) {
    await purgeOrgObjects(orgId).catch(() => {});
    await Promise.all([c.orgs.deleteMany({ _id: orgId }), c.departments.deleteMany({ orgId }), c.projects.deleteMany({ orgId }), c.orgDocuments.deleteMany({ orgId }), c.orgActivity.deleteMany({ orgId }),
      c.db.collection("s3_credentials").deleteMany({ ownerId: String(orgId) }), c.db.collection("s3_owner_keys").deleteMany({ ownerId: String(orgId) })]);
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await (await mongoClientPromise).close();
});

test("terraform: init, apply a bucket and two objects, read one back through a data source", { timeout: 1_200_000 }, (t) => {
  if (!up) return t.skip("no dev server"); if (!tf) return t.skip("terraform is not installed");
  let r = run(["init", "-no-color"]); assert.equal(r.status, 0, "init: " + r.out.slice(-1500));
  r = run(["apply", "-auto-approve", "-no-color"]); assert.equal(r.status, 0, "apply: " + r.out.slice(-3500));
  assert.match(r.out, /Apply complete! Resources: 3 added/);
  assert.match(r.out, /read_back_body = "hello from terraform"/, "the data source read the object back through the endpoint");
});

test("terraform: a second plan shows no changes (the endpoint reports state faithfully)", { timeout: 600_000 }, (t) => {
  if (!up || !tf) return t.skip("prerequisites missing");
  const r = run(["plan", "-detailed-exitcode", "-no-color"]);
  assert.equal(r.status, 0, "exit 0 = no changes; got: " + r.out.slice(-3000));
});

test("terraform: changing an object updates it in place, then destroy removes everything", { timeout: 900_000 }, (t) => {
  if (!up || !tf) return t.skip("prerequisites missing");
  fs.writeFileSync(path.join(dir, "main.tf"), config("hello again, updated"));
  let r = run(["apply", "-auto-approve", "-no-color"]); assert.equal(r.status, 0, "update: " + r.out.slice(-3000));
  assert.match(r.out, /1 changed|Resources: 0 added, 1 changed/); assert.match(r.out, /read_back_body = "hello again, updated"/);
  r = run(["destroy", "-auto-approve", "-no-color"]); assert.equal(r.status, 0, "destroy: " + r.out.slice(-3000));
  assert.match(r.out, /Destroy complete! Resources: 3 destroyed/);
});
