import { MongoClient } from 'mongodb';
import { installTestDeleteGuard } from './testDeleteGuard.js';

// Under the Node test runner only: refuse deletes that could match more than the test's own records
// (see testDeleteGuard.js; a cleanup with an undefined id wiped whole collections on 14 Nov 2026).
if (process.env.NODE_TEST_CONTEXT) installTestDeleteGuard();

// Under the Node test runner, tests use the separate TEST database (TEST_MONGODB_URI, its own Atlas
// project) and never the live one: on 14 Nov 2026 a test cleanup wiped live collections. A test run
// without TEST_MONGODB_URI, or with it pointing at the live cluster, stops here instead.
function testDatabaseUri() {
  const testUri = process.env.TEST_MONGODB_URI;
  if (!testUri) throw new Error("Tests need TEST_MONGODB_URI in .env.local (the separate test database). Refusing to run tests against the live database.");
  const host = (u) => { try { return new URL(String(u).replace(/^mongodb\+srv/, "http")).host; } catch { return ""; } };
  // The live cluster's host is remembered before MONGODB_URI is switched (child test processes inherit it).
  const liveHost = process.env.INAYA_LIVE_DB_HOST || (process.env.MONGODB_URI !== testUri ? host(process.env.MONGODB_URI) : "");
  if (liveHost) process.env.INAYA_LIVE_DB_HOST = liveHost;
  if (liveHost && host(testUri) === liveHost) throw new Error("TEST_MONGODB_URI points at the live cluster. Refusing to run tests.");
  return testUri;
}
// INAYA_USE_TEST_DB=1 (npm run dev:testdb) runs a local dev server on the test database too, so
// end-to-end tests that call http://localhost:3000 see the data they created. Never set on Vercel.
if (process.env.NODE_TEST_CONTEXT || process.env.INAYA_USE_TEST_DB === "1") process.env.MONGODB_URI = testDatabaseUri();
const uri = process.env.MONGODB_URI;
// Serverless: every function instance keeps its own pool, and the cluster
// allows 500 connections in total. With the driver's default (up to 100 per
// instance, idle ones kept open) a burst of parallel requests -- one Business
// Workspace screen fires several -- spun up enough instances to exhaust the
// limit, and Atlas then refused new connections ("tlsv1 alert internal
// error", pool cleared), failing every API at once (2026-10-24). A small
// pool per instance, with idle connections closed, keeps the total well
// under the limit; requests within one instance queue briefly instead.
const options = {
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 10000,
};

let client;
let clientPromise;

if (!process.env.MONGODB_URI) {
  throw new Error('Please add your MONGODB_URI to .env.local file');
}

if (process.env.NODE_ENV === 'development') {
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri, options);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

export async function connectToDatabase() {
  const client = await clientPromise;
  const db = client.db("inaya_network_corporate");
  return { client, db };
}

// Bhasudi khatam karne wali aakhri line
export default clientPromise;
