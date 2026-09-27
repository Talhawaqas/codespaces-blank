// SQA-002 regression test: /api/points requires proof of wallet control. Nothing reaches a valid, state-changing request.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { POST as pointsPost } from "../src/app/api/points/route.js";
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

test("SQA-002: /api/points refuses unauthenticated, forged and unknown-action requests", async () => {
  const anon = await pointsPost(req({ walletAddress: wallet.address, actionType: "UPLOAD" }));
  assert.equal(anon.status, 401, "no signature at all");
  const now = Date.now();
  const forged = await metaSig(other, { action: "awardPoints", resourceId: "UPLOAD", timestamp: now }); // signed by someone else
  const wrongSigner = await pointsPost(req({ walletAddress: wallet.address, actionType: "UPLOAD", message: forged.message, signature: forged.signature, timestamp: now }));
  assert.equal(wrongSigner.status, 401, "a signature from another wallet cannot mint points for this one");
  const unknown = await pointsPost(req({ walletAddress: wallet.address, actionType: "MINT_EVERYTHING" }));
  assert.equal(unknown.status, 400, "unknown actions are no longer silently accepted");
  const otherAction = await metaSig(wallet, { action: "registerFileMetadata", resourceId: "UPLOAD", timestamp: now });
  const replayAcrossAction = await pointsPost(req({ walletAddress: wallet.address, actionType: "UPLOAD", message: otherAction.message, signature: otherAction.signature, timestamp: now }));
  assert.equal(replayAcrossAction.status, 401, "a signature for a different action cannot be reused here");
});

