// SQA-024: preloaded by the test runner (--import). Many test files leave the MongoDB connection open, so their process never exited after the tests
// passed and a full run hung (found on ai-tool-registry, s3-compat-store, s3-compat-capabilities). Closing the shared connection once a file's tests finish
// fixes every file at once, without touching the ~40 files that lack an explicit close.
import { after } from "node:test";

after(async () => {
  const pending = globalThis.__inayaMongoClientPromise || globalThis._mongoClientPromise;
  if (!pending) return;
  try { const client = await pending; await client.close(); } catch { /* already closed */ }
});
