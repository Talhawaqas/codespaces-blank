// src/lib/nodeAuth.js
//
// Signature verification for the node-daemon's register/heartbeat calls — mirrors
// metadata-auth.js's verifyMetadataAuth line-for-line, and must match custody-sdk's
// packages/node-daemon/src/nodeAuth.js's buildNodeActionMessage() exactly (any drift breaks every
// daemon in the field). Before this existed, /api/nodes/register and /api/nodes/heartbeat trusted
// a plain, unverified { nodeId, operatorWallet, ... } body — anyone could POST telemetry for any
// wallet address without proving they control it, which matters here because heartbeat data feeds
// uptimeScoreBps/tier (reward-eligibility-adjacent), and heartbeat's own upsert:true meant a
// forged nodeId didn't even need a prior real registration to start writing data.

import { ethers } from "ethers";

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // 5 minutes, same window metadata-auth.js uses

/** Recomputes node-daemon's buildNodeActionMessage() output and confirms the signature recovers
 *  to `operatorWallet` (nodeId is always the operator's own lowercased address — resolveWallet.js
 *  in the daemon never allows the two to diverge). Throws so every caller fails closed. */
export function verifyNodeAuth({ action, nodeId, operatorWallet, message, signature, timestamp }) {
  if (!nodeId || !operatorWallet || !message || !signature || typeof timestamp !== "number") {
    throw new Error("Missing auth fields — nodeId, operatorWallet, message, signature, and timestamp are all required.");
  }
  if (nodeId !== operatorWallet.toLowerCase()) {
    throw new Error("nodeId must be the operator wallet's own lowercased address.");
  }
  if (Date.now() - timestamp > MAX_SIGNATURE_AGE_MS) {
    throw new Error("Signature expired — please retry.");
  }

  const expectedMessage = ["Inaya Node Action", `action: ${action}`, `nodeId: ${nodeId}`, `timestamp: ${timestamp}`].join("\n");
  if (message !== expectedMessage) {
    throw new Error("Signed message doesn't match the request fields — possible tampering.");
  }

  const recovered = ethers.verifyMessage(message, signature);
  if (recovered.toLowerCase() !== operatorWallet.toLowerCase()) {
    throw new Error("Signature does not match the claimed operator wallet.");
  }
}
