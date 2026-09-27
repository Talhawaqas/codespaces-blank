// SQA real-client regression test (SOW section 11: "validate real clients/tools"). Drives the actual AWS CLI (botocore) against a RUNNING Inaya server.
// Skipped, with the reason, when no server answers at SQA_S3_BASE (default http://localhost:3000) or the `aws` CLI is not installed -- so it never
// reports compatibility it did not observe. It covers defects only a real client found:
//   022 keys with spaces / parentheses / plus / ampersand / non-ASCII authenticate (canonical URI was double-encoded)
//   021 a ranged GET does not fail the CLI's checksum validation
//   018/016/020 a multi-part upload completes once and downloads back byte-identical
//   019 an `aws s3 presign` URL works
//   023 ETag is the content MD5 (single part) and md5-of-part-md5s-N (multipart), as real S3
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import clientPromise from "../src/lib/mongodb.js";

if (!process.env.INTEGRATION_ENCRYPTION_KEY) process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const BASE = process.env.SQA_S3_BASE || "http://localhost:3000"; const ENDPOINT = `${BASE}/api/s3`;
const md5 = (b) => createHash("md5").update(b).digest("hex");
const hasAws = spawnSync("aws", ["--version"]).status === 0;
let serverUp = false; try { const r = await fetch(`${ENDPOINT}`, { signal: AbortSignal.timeout(5000) }); serverUp = r.status > 0; } catch { serverUp = false; }
const skip = !hasAws ? "the aws CLI is not installed" : !serverUp ? `no Inaya server answered at ${BASE}` : false;

const RUN = randomBytes(3).toString("hex"); let orgId; let env; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sqa-s3-")); const bucket = `sqa-rc-${RUN}`;
const aws = (args, o = {}) => spawnSync("aws", ["--endpoint-url", ENDPOINT, ...args], { env: { ...process.env, ...env, ...(o.env || {}) }, encoding: "utf8", timeout: o.timeout || 240000 });
const ok = (r, what) => assert.equal(r.status, 0, `${what}: ${(r.stderr || r.stdout || "").split(/\r?\n/).filter(Boolean).slice(-2).join(" | ")}`);

async function setup() {
  await ensureOrgIndexes(); const c = await getOrgCollections(); await ensureS3CompatIndexes(c.db);
  orgId = (await c.orgs.insertOne({ name: `sqa-rc-${RUN}`, createdAt: new Date().toISOString() })).insertedId;
  const cred = await issueS3Credential({ owner: { type: "org", orgId: String(orgId) }, label: "sqa-realclient", actorEmail: `sqa-${RUN}@example.com` });
  env = { AWS_ACCESS_KEY_ID: cred.accessKeyId, AWS_SECRET_ACCESS_KEY: cred.secretAccessKey, AWS_DEFAULT_REGION: "inaya", AWS_EC2_METADATA_DISABLED: "true" };
}
after(async () => {
  try { const c = await getOrgCollections(); for (const n of (await c.db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name)) { try { await c.db.collection(n).deleteMany({ orgId }); } catch { /* ignore */ } }
    await c.db.collection("s3_credentials").deleteMany({ ownerId: String(orgId) }); await c.db.collection("s3_owner_keys").deleteMany({ ownerId: String(orgId) }); await c.orgs.deleteMany({ _id: orgId }); } catch { /* best effort */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await (await clientPromise).close(); } catch { /* ignore */ }
});

test("022/023: keys with special characters authenticate, round-trip byte-identically and carry the content MD5 as ETag", { skip, timeout: 600000 }, async () => {
  await setup(); ok(aws(["s3", "mb", `s3://${bucket}`]), "mb");
  const body = randomBytes(150000); const local = path.join(tmp, "in.bin"); fs.writeFileSync(local, body);
  for (const key of ["plain.bin", "with space.bin", "paren(1).bin", "plus+sign.bin", "ünï.bin", "a&b=c.bin", "dir/sub dir/x y.bin", "100%.bin"]) {
    ok(aws(["s3", "cp", local, `s3://${bucket}/${key}`]), `upload "${key}"`);
    const back = path.join(tmp, "out.bin"); fs.rmSync(back, { force: true });
    ok(aws(["s3", "cp", `s3://${bucket}/${key}`, back]), `download "${key}"`);
    assert.equal(md5(fs.readFileSync(back)), md5(body), `"${key}" is byte-identical`);
  }
  const head = JSON.parse(aws(["s3api", "head-object", "--bucket", bucket, "--key", "with space.bin"]).stdout);
  assert.equal(head.ETag, `"${md5(body)}"`, "single-part ETag is the content MD5");
  const list = JSON.parse(aws(["s3api", "list-objects-v2", "--bucket", bucket]).stdout);
  assert.equal(list.Contents.find((o) => o.Key === "with space.bin").ETag, `"${md5(body)}"`, "the listing reports the same ETag");
});

test("021/019: a ranged GET passes the client's validation, a presigned URL works, a wrong secret is refused", { skip, timeout: 300000 }, async () => {
  const body = randomBytes(300000); const local = path.join(tmp, "r.bin"); fs.writeFileSync(local, body);
  ok(aws(["s3", "cp", local, `s3://${bucket}/range.bin`]), "upload");
  const out = path.join(tmp, "range.out");
  ok(aws(["s3api", "get-object", "--bucket", bucket, "--key", "range.bin", "--range", "bytes=1000-1999", out]), "ranged get");
  assert.equal(Buffer.compare(fs.readFileSync(out), body.subarray(1000, 2000)), 0, "exactly the requested bytes");
  const url = aws(["s3", "presign", `s3://${bucket}/range.bin`, "--expires-in", "120"]).stdout.trim();
  const res = await fetch(url); assert.equal(res.status, 200); assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), body), 0, "a presigned URL downloads the object");
  const put = await fetch(url, { method: "PUT", body: "x" }); assert.ok(put.status >= 400, "a GET link cannot be used to write");
  const bad = aws(["s3", "ls", `s3://${bucket}/`], { env: { AWS_SECRET_ACCESS_KEY: "wrong".repeat(8) } });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /SignatureDoesNotMatch/);
});

test("016/018/020: a 17 MB multi-part upload completes once, downloads byte-identically and has the multipart ETag", { skip, timeout: 900000 }, async () => {
  const body = randomBytes(17 * 1024 * 1024); const local = path.join(tmp, "big.bin"); fs.writeFileSync(local, body);
  ok(aws(["s3", "cp", local, `s3://${bucket}/big.bin`]), "multipart upload");
  const chunk = 8 * 1024 * 1024; const partMd5s = []; for (let o = 0; o < body.length; o += chunk) partMd5s.push(createHash("md5").update(body.subarray(o, o + chunk)).digest());
  const expected = `${createHash("md5").update(Buffer.concat(partMd5s)).digest("hex")}-${partMd5s.length}`;
  const head = JSON.parse(aws(["s3api", "head-object", "--bucket", bucket, "--key", "big.bin"]).stdout);
  assert.equal(head.ContentLength, body.length); assert.equal(head.ETag, `"${expected}"`, "multipart ETag is md5-of-part-md5s-N, as in real S3");
  const back = path.join(tmp, "big.out"); ok(aws(["s3", "cp", `s3://${bucket}/big.bin`, back]), "download");
  assert.equal(md5(fs.readFileSync(back)), md5(body), "byte-identical");
  const c = await getOrgCollections();
  assert.equal(await c.orgDocuments.countDocuments({ orgId, filename: "big.bin", deletedAt: null }), 1, "the client's timeout-driven retries did not write the object twice");
});
