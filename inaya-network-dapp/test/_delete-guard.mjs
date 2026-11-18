// test/_delete-guard.mjs: loaded first by the npm test scripts (--import), before any test module.
// 1) Points the whole run at the separate TEST database (TEST_MONGODB_URI) and refuses to start without
//    it or if it names the live cluster; src/lib/mongodb.js enforces the same under the test runner.
// 2) Installs the delete guard (src/lib/testDeleteGuard.js).
import { installTestDeleteGuard } from "../src/lib/testDeleteGuard.js";

// Suites written for plain S3 / NAS semantics keep the old defaults; test/protection-defaults.test.mjs turns the
// production defaults (versioned buckets, daily immutable NAS snapshots) on explicitly (src/lib/protectionDefaults.js).
process.env.S3_DEFAULT_VERSIONING ??= "off";
process.env.NAS_DEFAULT_SNAPSHOTS ??= "off";
const testUri = process.env.TEST_MONGODB_URI;
if (!testUri) throw new Error("Tests need TEST_MONGODB_URI in .env.local (the separate test database). Refusing to run tests against the live database.");
const host = (u) => { try { return new URL(String(u).replace(/^mongodb\+srv/, "http")).host; } catch { return ""; } };
// The live cluster's host is remembered before MONGODB_URI is switched (child test processes inherit it).
const liveHost = process.env.INAYA_LIVE_DB_HOST || (process.env.MONGODB_URI !== testUri ? host(process.env.MONGODB_URI) : "");
if (liveHost) process.env.INAYA_LIVE_DB_HOST = liveHost;
if (liveHost && host(testUri) === liveHost) throw new Error("TEST_MONGODB_URI points at the live cluster. Refusing to run tests.");
process.env.MONGODB_URI = testUri;

installTestDeleteGuard();
