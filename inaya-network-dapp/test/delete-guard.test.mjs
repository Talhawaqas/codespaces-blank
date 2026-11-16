// test/delete-guard.test.mjs
// The test delete guard (src/lib/testDeleteGuard.js) refuses deletes that could match more than a
// test's own records. Pure checks: nothing here reaches the database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { check } from "../src/lib/testDeleteGuard.js";

const col = (name) => ({ collectionName: name });
const refuses = (name, filter) => assert.throws(() => check(col(name), "deleteMany", filter), /Test delete guard/);
const allows = (name, filter) => assert.doesNotThrow(() => check(col(name), "deleteMany", filter));

test("refuses the 14 Nov pattern: an undefined orgId", () => {
  let orgId; // setup failed before it was assigned
  refuses("orgs", { orgId });
  refuses("sales_leads", { orgId: { $in: [orgId] } });
  refuses("orgs", { _id: { $in: [undefined, null] } });
});

test("refuses an empty filter, except on scratch collections", () => {
  refuses("orgs", {});
  refuses("sales_leads", {});
  allows("drm_sessions", {});
});

test("refuses a null id and an empty id list", () => {
  refuses("org_members", { orgId: null });
  refuses("orgs", { _id: { $in: [] } });
});

test("allows deletes by the exact ids a test created", () => {
  const id = new ObjectId();
  allows("orgs", { _id: id });
  allows("orgs", { _id: { $in: [id, new ObjectId()] } });
  allows("org_members", { orgId: { $in: [id, String(id)] } });
  allows("notifications", { targetEmail: { $regex: "run-123" } });
});
