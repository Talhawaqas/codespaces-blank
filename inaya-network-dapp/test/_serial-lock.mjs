// test/_serial-lock.mjs
// A cross-process lock for test files that share global state (for example the Watcher program's
// single enrollment counter), so the parallel test runner runs them one at a time instead of letting
// one file fill the cap while another enrolls. Held as a document in the TEST database; a lock older
// than STALE_MS (a crashed run) is taken over.
import { connectToDatabase } from "../src/lib/mongodb.js";

const STALE_MS = 15 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function acquireTestLock(name, { waitMs = 20 * 60 * 1000 } = {}) {
  const { db } = await connectToDatabase();
  const col = db.collection("test_locks");
  const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await col.insertOne({ _id: name, owner, takenAt: new Date() });
      return async () => { await col.deleteOne({ _id: name, owner }); };
    } catch (err) {
      if (err?.code !== 11000) throw err;
      await col.deleteOne({ _id: name, takenAt: { $lt: new Date(Date.now() - STALE_MS) } });
      if (Date.now() > deadline) throw new Error(`Timed out waiting for test lock "${name}"`);
      await sleep(1000);
    }
  }
}
