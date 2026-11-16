// src/lib/testDeleteGuard.js
//
// Installed by src/lib/mongodb.js whenever the Node test runner is active (NODE_TEST_CONTEXT is set),
// and by test/_delete-guard.mjs (package.json "test" script --import). Inert in the running app.
// The test suite used to run against the real database, and on 14 Nov 2026 a cleanup like
// `deleteMany({ orgId })` ran with orgId undefined: MongoDB treats that as "orgId is null or missing",
// which matched EVERY record in collections without an orgId (all companies, the sales leads, Watcher
// history). This guard makes such a delete throw instead.
//
// A delete is refused when nothing real limits what it matches:
//  - an empty filter {} (except on the few scratch collections tests legitimately clear);
//  - a filter whose every condition is empty: undefined, null, or an $in list holding only
//    undefined/null (e.g. { orgId: undefined }, { _id: { $in: [undefined] } });
//  - an $in list on an id field that mixes empty values with real ones ([undefined, realId]): the
//    empty entry alone matches every record without that field;
//  - the same rules inside every $or / $and branch.
// Allowed: conditions that are null next to a real constraint ({ orgId, handedOffTicketId: null }),
// and an empty $in list ({ _id: { $in: [] } } matches nothing). drop(), dropCollection() and
// dropDatabase() are always refused.

import { Collection, Db } from "mongodb";

const SCRATCH_OK_TO_EMPTY = new Set(["file_share_access_events", "drm_sessions", "share_email_codes", "gateway_nonces", "backupObjectState", "voice_open_sessions"]);
const ID_KEY = /(^_id$|Id$)/;
const isEmptyValue = (v) => v === undefined || v === null;

/** Returns a reason the filter is unsafe, or null. */
function unsafe(filter, path = "filter") {
  if (filter === undefined || filter === null) return `${path} is empty`;
  if (typeof filter !== "object" || Array.isArray(filter)) return null;
  const entries = Object.entries(filter);
  if (entries.length === 0) return `${path} is {}`;
  let realConditions = 0;
  for (const [k, v] of entries) {
    if (k === "$or" || k === "$and" || k === "$nor") {
      if (!Array.isArray(v) || v.length === 0) continue;
      for (let i = 0; i < v.length; i++) { const p = unsafe(v[i], `${path}.${k}[${i}]`); if (p) return p; }
      realConditions++;
      continue;
    }
    if (isEmptyValue(v)) continue; // matches "field missing"; fine only next to a real condition
    if (v && typeof v === "object" && !Array.isArray(v) && !v._bsontype && !(v instanceof Date) && !(v instanceof RegExp)) {
      const ops = Object.entries(v);
      if (Array.isArray(v.$in)) {
        const empties = v.$in.filter(isEmptyValue).length;
        if (empties && empties < v.$in.length && ID_KEY.test(k)) return `${path}.${k}.$in mixes empty values with real ids`;
        if (empties && empties === v.$in.length && ops.length === 1) continue; // only empties: not a real condition
      }
      if (ops.length && ops.every(([op, x]) => op === "$eq" && isEmptyValue(x))) continue;
    }
    realConditions++;
  }
  return realConditions === 0 ? `every condition in ${path} is empty (it would match every record without those fields)` : null;
}

export function check(collection, method, filter) {
  const name = collection.collectionName;
  if (filter && typeof filter === "object" && !Array.isArray(filter) && Object.keys(filter).length === 0) {
    if (SCRATCH_OK_TO_EMPTY.has(name)) return;
    throw new Error(`Test delete guard: ${method} on "${name}" with an empty filter would delete every record. Delete by the exact ids the test created.`);
  }
  const p = unsafe(filter);
  if (p) throw new Error(`Test delete guard: ${method} on "${name}" refused because ${p}. Delete by the exact ids the test created.`);
}

export function installTestDeleteGuard() {
  if (globalThis.__inayaDeleteGuard) return;
  globalThis.__inayaDeleteGuard = true;
  for (const method of ["deleteMany", "deleteOne", "findOneAndDelete"]) {
    const original = Collection.prototype[method];
    Collection.prototype[method] = function guarded(filter, ...rest) {
      check(this, method, filter);
      return original.call(this, filter, ...rest);
    };
  }
  Collection.prototype.drop = function () { throw new Error(`Test delete guard: drop() on "${this.collectionName}" is not allowed in tests.`); };
  Db.prototype.dropCollection = function (name) { throw new Error(`Test delete guard: dropCollection("${name}") is not allowed in tests.`); };
  Db.prototype.dropDatabase = function () { throw new Error("Test delete guard: dropDatabase() is not allowed in tests."); };
}
