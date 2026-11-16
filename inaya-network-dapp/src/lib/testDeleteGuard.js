// src/lib/testDeleteGuard.js
//
// Installed by src/lib/mongodb.js whenever the Node test runner is active (NODE_TEST_CONTEXT is set),
// and by test/_delete-guard.mjs (package.json "test" script --import). Inert in the running app. The test suite runs against the real
// database, and on 14 Nov 2026 a cleanup like `deleteMany({ orgId })` ran with orgId undefined: MongoDB
// treats that as "orgId is null or missing", which matched EVERY record in collections without an orgId
// (all companies, the sales leads, Watcher history). This guard makes such a delete throw instead.
//
// Refused during tests:
//  - an empty filter {} (except on the few scratch collections tests legitimately clear),
//  - any filter containing undefined, or null where an id is expected (orgId/_id/…Id fields),
//  - $in / $nin lists containing undefined or null, or an empty $in on an id field,
//  - drop(), dropCollection(), dropDatabase().

import { Collection, Db } from "mongodb";

const SCRATCH_OK_TO_EMPTY = new Set(["file_share_access_events", "drm_sessions", "share_email_codes", "gateway_nonces", "backupObjectState", "voice_open_sessions"]);
const ID_KEY = /(^_id$|Id$|^orgId$)/;

function problem(filter, path = "filter") {
  if (filter === undefined) return `${path} is undefined`;
  if (filter === null || typeof filter !== "object") return null;
  if (Array.isArray(filter)) {
    for (let i = 0; i < filter.length; i++) { const p = problem(filter[i], `${path}[${i}]`); if (p) return p; }
    return null;
  }
  if (filter._bsontype || filter instanceof Date || filter instanceof RegExp) return null;
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined) return `${path}.${k} is undefined`;
    if (v === null && ID_KEY.test(k)) return `${path}.${k} is null (matches every record without that field)`;
    if ((k === "$in" || k === "$nin") && Array.isArray(v) && v.some((x) => x === undefined || x === null)) return `${path}.${k} contains an empty value`;
    if (k === "$in" && Array.isArray(v) && v.length === 0 && ID_KEY.test(path.split(".").pop())) return `${path}.$in is an empty id list`;
    const p = problem(v, `${path}.${k}`);
    if (p) return p;
  }
  return null;
}

export function check(collection, method, filter) {
  const name = collection.collectionName;
  if (filter && typeof filter === "object" && !Array.isArray(filter) && Object.keys(filter).length === 0 && !SCRATCH_OK_TO_EMPTY.has(name)) {
    throw new Error(`Test delete guard: ${method} on "${name}" with an empty filter would delete every record. Delete by the exact ids the test created.`);
  }
  const p = problem(filter);
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
