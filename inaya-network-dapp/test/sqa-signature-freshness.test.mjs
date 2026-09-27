// SQA-001 regression test: a signature dated in the future must be rejected, not valid forever.
import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { verifyMetadataAuth } from "../src/lib/metadata-auth.js";
import { verifyNodeAuth } from "../src/lib/nodeAuth.js";

const wallet = ethers.Wallet.createRandom();

async function metaSig(signer, { action, resourceId, extra, timestamp }) {
  const lines = ["Inaya Metadata Action", `action: ${action}`, `resourceId: ${resourceId}`];
  if (extra) for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${String(v)}`);
  lines.push(`timestamp: ${timestamp}`);
  const message = lines.join("\n");
  return { address: signer.address, message, signature: await signer.signMessage(message), timestamp };
}

test("SQA-001: a signature dated in the future is rejected, not valid forever (metadata and node verifiers)", async () => {
  const future = Date.now() + 10 * 24 * 60 * 60 * 1000;
  const m = await metaSig(wallet, { action: "registerFileMetadata", resourceId: "0xabc", timestamp: future });
  assert.throws(() => verifyMetadataAuth({ action: "registerFileMetadata", resourceId: "0xabc", ...m }), /expired/i);
  const now = Date.now(); const ok = await metaSig(wallet, { action: "registerFileMetadata", resourceId: "0xabc", timestamp: now });
  verifyMetadataAuth({ action: "registerFileMetadata", resourceId: "0xabc", ...ok }); // a fresh one still works

  const NID = wallet.address.toLowerCase();
  const nodeMsg = (ts) => ["Inaya Node Action", "action: heartbeat", `nodeId: ${NID}`, `timestamp: ${ts}`].join("\n");
  const fm = nodeMsg(future); const fsig = await wallet.signMessage(fm);
  assert.throws(() => verifyNodeAuth({ action: "heartbeat", nodeId: NID, operatorWallet: wallet.address, message: fm, signature: fsig, timestamp: future }), /expired/i);
  const nm = nodeMsg(now);
  verifyNodeAuth({ action: "heartbeat", nodeId: NID, operatorWallet: wallet.address, message: nm, signature: await wallet.signMessage(nm), timestamp: now });
});

