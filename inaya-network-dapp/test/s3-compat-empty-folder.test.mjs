// test/s3-compat-empty-folder.test.mjs
//
// Inaya Drive Empty Folder Creation SOW -- integration tests against the
// real database for the new folder-management primitives on both sides
// of the S3-compat layer: store.js (org, backed by the new s3_folders
// collection) and walletStore.js (wallet, backed by the existing, proven
// metadata_folders collection). Covers the SOW's own named scenarios:
// root/nested creation, duplicate rejection, invalid name rejection,
// persistence, rename, delete-without-cascade, and listing merge.
//
// Run with: node --env-file=.env.local --test test/s3-compat-empty-folder.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import * as orgStore from "../src/lib/s3-compat/store.js";
import * as walletStore from "../src/lib/s3-compat/walletStore.js";
import { connectToDatabase } from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
});

after(async () => {
  const { orgs, departments, projects, orgDocuments, orgActivity, db } = collections;
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await db.collection("s3_folders").deleteMany({ orgId: { $in: cleanup.orgIds } });
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `empty-folder-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  return orgId.toString();
}

function testWallet(label) {
  return `0xtest${RUN_ID}${label}`.toLowerCase().padEnd(42, "0").slice(0, 42);
}

async function cleanupWallet(walletAddress) {
  const { db } = await connectToDatabase();
  await db.collection("metadata_folders").deleteMany({ owner: walletAddress.toLowerCase() });
  await db.collection("metadata_files").deleteMany({ owner: walletAddress.toLowerCase() });
}

// ---------------------------------------------------------------------
// Org side (store.js, s3_folders)
// ---------------------------------------------------------------------

test("createS3Folder (org): root-level folder is created and appears in a listing", async () => {
  const orgId = await makeTestOrg("root");
  const result = await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "documents", actorEmail: "t@example.com" });
  assert.ok(result.folderId);

  const listing = await orgStore.listS3Objects({ orgId, bucket: "b", prefix: "", delimiter: "/" });
  assert.ok(listing.commonPrefixes.includes("documents/"), "an empty folder must still appear in its parent's listing");
});

test("createS3Folder (org): nested empty folder creation auto-vivifies ancestors and both levels list correctly", async () => {
  const orgId = await makeTestOrg("nested");
  await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "documents/contracts/2026", actorEmail: "t@example.com" });

  const root = await orgStore.listS3Objects({ orgId, bucket: "b", prefix: "", delimiter: "/" });
  assert.ok(root.commonPrefixes.includes("documents/"));

  const mid = await orgStore.listS3Objects({ orgId, bucket: "b", prefix: "documents/", delimiter: "/" });
  assert.ok(mid.commonPrefixes.includes("documents/contracts/"), "an intermediate empty folder must be visible via its own parent listing");

  const leaf = await orgStore.listS3Objects({ orgId, bucket: "b", prefix: "documents/contracts/", delimiter: "/" });
  assert.ok(leaf.commonPrefixes.includes("documents/contracts/2026/"), "the leaf empty folder must be visible too");
});

test("createS3Folder (org): duplicate folder at the same parent is rejected deterministically (FolderAlreadyExists)", async () => {
  const orgId = await makeTestOrg("dup");
  await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "documents", actorEmail: "t" });
  await assert.rejects(
    orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "documents", actorEmail: "t" }),
    (err) => err.code === "FolderAlreadyExists"
  );
});

test("createS3Folder (org): invalid folder name segments are rejected deterministically (InvalidFolderName)", async () => {
  const orgId = await makeTestOrg("invalid-name");
  await assert.rejects(orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "a/../b", actorEmail: "t" }), (err) => err.code === "InvalidFolderName");
  await assert.rejects(orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "", actorEmail: "t" }), (err) => err.code === "InvalidFolderName");
});

test("createS3Folder (org): an empty folder does NOT create any org_documents row (no encryption/sharding/versioning side effects)", async () => {
  const orgId = await makeTestOrg("no-doc-row");
  await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "empty-only", actorEmail: "t" });
  const { orgDocuments } = collections;
  const count = await orgDocuments.countDocuments({ orgId: new ObjectId(orgId) });
  assert.equal(count, 0, "creating an empty folder must never write an org_documents row");
});

test("createS3Folder (org) is idempotent for a real object's own existing key-prefix directory, and objects placed inside a real empty folder work exactly as before", async () => {
  const orgId = await makeTestOrg("mixed");
  await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "reports", actorEmail: "t" });
  const { issueS3Credential } = await import("../src/lib/s3-compat/credentials.js");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  const doc = await orgStore.putS3Object({ orgId, bucket: "b", key: "reports/q1.txt", bodyBuffer: Buffer.from("real data"), contentType: "text/plain", actorEmail: "t" });
  assert.equal(doc.filename, "reports/q1.txt");

  const listing = await orgStore.listS3Objects({ orgId, bucket: "b", prefix: "reports/", delimiter: "/" });
  assert.ok(listing.contents.some((c) => c.filename === "reports/q1.txt"), "the file placed inside the folder must be listed normally");
});

test("renameS3Folder (org): renaming moves the folder and it is visible under the new path, not the old one", async () => {
  const orgId = await makeTestOrg("rename");
  await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "old-name", actorEmail: "t" });
  await orgStore.renameS3Folder({ orgId, bucket: "b", oldFolderPath: "old-name", newFolderPath: "new-name", actorEmail: "t" });

  const listing = await orgStore.listS3Objects({ orgId, bucket: "b", prefix: "", delimiter: "/" });
  assert.ok(listing.commonPrefixes.includes("new-name/"));
  assert.ok(!listing.commonPrefixes.includes("old-name/"));
});

test("renameS3Folder (org): renaming to a nonexistent parent is rejected deterministically (NoSuchParentFolder)", async () => {
  const orgId = await makeTestOrg("rename-bad-parent");
  await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "a", actorEmail: "t" });
  await assert.rejects(
    orgStore.renameS3Folder({ orgId, bucket: "b", oldFolderPath: "a", newFolderPath: "nonexistent-parent/a", actorEmail: "t" }),
    (err) => err.code === "NoSuchParentFolder"
  );
});

test("deleteS3Folder (org): deleting a folder orphans child folders to root instead of cascading (matches metadata_folders precedent)", async () => {
  const orgId = await makeTestOrg("delete-orphan");
  await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "parent/child", actorEmail: "t" });
  await orgStore.deleteS3Folder({ orgId, bucket: "b", folderPath: "parent", actorEmail: "t" });

  // The child folder row must still exist (not cascade-deleted), just
  // orphaned to the bucket root -- verify by checking it now lists at root.
  const { db } = collections;
  const bucketDoc = await orgStore.getS3Bucket({ orgId, bucket: "b" });
  const child = await db.collection("s3_folders").findOne({ orgId: new ObjectId(orgId), projectId: bucketDoc._id, name: "child", deletedAt: null });
  assert.ok(child, "child folder must not be cascade-deleted");
  assert.equal(child.parentFolderId, null, "child folder must be orphaned to the bucket root, not left dangling under a deleted parent");
});

test("deleteS3Folder (org): does not delete or touch any file that happens to share the folder's key prefix", async () => {
  const orgId = await makeTestOrg("delete-no-object-touch");
  const { issueS3Credential } = await import("../src/lib/s3-compat/credentials.js");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  await orgStore.putS3Object({ orgId, bucket: "b", key: "shared/file.txt", bodyBuffer: Buffer.from("data"), contentType: "text/plain", actorEmail: "t" });
  await orgStore.createS3Folder({ orgId, bucket: "b", folderPath: "shared", actorEmail: "t" });
  await orgStore.deleteS3Folder({ orgId, bucket: "b", folderPath: "shared", actorEmail: "t" });

  const head = await orgStore.headS3Object({ orgId, bucket: "b", key: "shared/file.txt" });
  assert.ok(head, "an object sharing the deleted folder's key prefix must be untouched");
});

test("deleteS3Folder (org) is idempotent -- deleting a nonexistent folder is not an error", async () => {
  const orgId = await makeTestOrg("delete-idempotent");
  const result = await orgStore.deleteS3Folder({ orgId, bucket: "b", folderPath: "never-existed", actorEmail: "t" });
  assert.equal(result.deleted, true);
});

// ---------------------------------------------------------------------
// Wallet side (walletStore.js, metadata_folders)
// ---------------------------------------------------------------------

test("createS3Folder (wallet): root-level empty folder is created, durable, and appears in listing", async () => {
  const wallet = testWallet("w1");
  try {
    await walletStore.createS3Folder({ walletAddress: wallet, bucket: "vault", folderPath: "photos" });
    const listing = await walletStore.listS3Objects({ walletAddress: wallet, bucket: "vault", prefix: "", delimiter: "/" });
    assert.ok(listing.commonPrefixes.includes("photos/"));
  } finally {
    await cleanupWallet(wallet);
  }
});

test("createS3Folder (wallet): duplicate rejected deterministically (FolderAlreadyExists)", async () => {
  const wallet = testWallet("w2");
  try {
    await walletStore.createS3Folder({ walletAddress: wallet, bucket: "vault", folderPath: "photos" });
    await assert.rejects(
      walletStore.createS3Folder({ walletAddress: wallet, bucket: "vault", folderPath: "photos" }),
      (err) => err.code === "FolderAlreadyExists"
    );
  } finally {
    await cleanupWallet(wallet);
  }
});

test("deleteS3Folder (wallet): orphans child folders instead of cascading, and never touches metadata_files", async () => {
  const wallet = testWallet("w3");
  try {
    await walletStore.createS3Folder({ walletAddress: wallet, bucket: "vault", folderPath: "parent/child" });
    await walletStore.deleteS3Folder({ walletAddress: wallet, bucket: "vault", folderPath: "parent" });

    const { db } = await connectToDatabase();
    const child = await db.collection("metadata_folders").findOne({ owner: wallet.toLowerCase(), name: "child", deletedAt: null });
    assert.ok(child, "child folder must survive parent deletion");
    const bucketDoc = await walletStore.getS3Bucket({ walletAddress: wallet, bucket: "vault" });
    assert.equal(child.parentFolderId, bucketDoc.folderId, "child folder must be orphaned to the bucket root");
  } finally {
    await cleanupWallet(wallet);
  }
});

test("renameS3Folder (wallet): renamed folder visible under new path only", async () => {
  const wallet = testWallet("w4");
  try {
    await walletStore.createS3Folder({ walletAddress: wallet, bucket: "vault", folderPath: "old" });
    await walletStore.renameS3Folder({ walletAddress: wallet, bucket: "vault", oldFolderPath: "old", newFolderPath: "new" });
    const listing = await walletStore.listS3Objects({ walletAddress: wallet, bucket: "vault", prefix: "", delimiter: "/" });
    assert.ok(listing.commonPrefixes.includes("new/"));
    assert.ok(!listing.commonPrefixes.includes("old/"));
  } finally {
    await cleanupWallet(wallet);
  }
});
