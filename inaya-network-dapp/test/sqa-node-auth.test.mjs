// SQA regression tests (docs/sqa/master-defect-registry.md): SQA-003 /api/nodes/assign,
// SQA-004 /api/nodes/queue-shard. Nothing here reaches a valid, state-changing request, so nothing in the shared database is modified.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { POST as assignPost } from "../src/app/api/nodes/assign/route.js";
import { POST as queuePost } from "../src/app/api/nodes/queue-shard/route.js";
import { connectToDatabase } from "../src/lib/mongodb.js";

after(async () => { try { const { client } = await connectToDatabase(); await client?.close?.(); } catch {} });

const wallet = ethers.Wallet.createRandom();
const other = ethers.Wallet.createRandom();
const req = (body) => new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function metaSig(signer, { action, resourceId, extra, timestamp }) {
  const lines = ["Inaya Metadata Action", `action: ${action}`, `resourceId: ${resourceId}`];
  if (extra) for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${String(v)}`);
  lines.push(`timestamp: ${timestamp}`);
  const message = lines.join("\n");
  return { address: signer.address, message, signature: await signer.signMessage(message), timestamp };
}

test("SQA-003/004: node assignment and shard queueing need a wallet signature; oversized reservations are refused", async () => {
  assert.equal((await assignPost(req({ requiredCapacityGB: 5 }))).status, 401);
  assert.equal((await queuePost(req({ shardId: "s1", sizeGB: 1 }))).status, 401);
  const now = Date.now();
  const huge = await metaSig(wallet, { action: "assignNode", resourceId: "node-assignment", extra: { requiredCapacityGB: 100000, minTier: "Entry" }, timestamp: now });
  const r = await assignPost(req({ requiredCapacityGB: 100000, address: huge.address, message: huge.message, signature: huge.signature, timestamp: now }));
  assert.equal(r.status, 400, "a reservation larger than the cap is refused before any node is touched");
  const stale = await metaSig(wallet, { action: "queueShard", resourceId: "s1", extra: { sizeGB: 1 }, timestamp: now - 3600_000 });
  assert.equal((await queuePost(req({ shardId: "s1", sizeGB: 1, address: stale.address, message: stale.message, signature: stale.signature, timestamp: now - 3600_000 }))).status, 401);
  assert.equal((await queuePost(req({ shardId: "s1", sizeGB: -5 }))).status, 400, "invalid sizes are rejected");
});
