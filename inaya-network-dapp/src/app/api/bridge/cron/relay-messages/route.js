// GET /api/bridge/cron/relay-messages
//
// CRON_SECRET-gated. For every pending/validating transfer with a recorded full Message struct,
// each configured validator key signs the message hash (BRIDGE_VALIDATOR_PRIVATE_KEY_1..N,
// same single-operator-testnet-phase precedent as RELAYER_PRIVATE_KEY elsewhere in this
// codebase); once BRIDGE_VALIDATOR_THRESHOLD signatures are collected, the relayer wallet
// submits executeMessage on the destination chain -- the relayer sponsors destination gas for
// every direction during the testnet phase (decision #4 in the SOW-1 plan), so users never hit
// a "no gas on a chain I've never touched" dead end.

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { CHAINS } from "@/lib/chains";
import { getPendingTransfersWithMessage, recordValidatorSignature, getSignaturesFor, markTransferStatus, recordTransferInitiated, verifyMessageOnSource, hashBridgeMessage } from "@/lib/bridge";
import { getAdapter } from "@/lib/chain-adapters";

import { isAuthorizedCron } from "@/lib/cronAuth";
const MESSENGER_ABI = [
  "function executeMessage(tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message, bytes[] signatures) external",
];

// A malformed BRIDGE_VALIDATOR_PRIVATE_KEY_N (wrong length, missing 0x,
// etc.) made `new ethers.Wallet(k)` throw synchronously here, outside
// every try/catch in this route -- crashing the whole cron with an
// opaque 500 instead of naming which key was bad. Confirmed live: the
// route's own per-transfer try/catch never even runs when this throws.
function getValidatorWallets() {
  const keys = [];
  const badIndexes = [];
  for (let i = 1; i <= 9; i++) {
    const k = process.env[`BRIDGE_VALIDATOR_PRIVATE_KEY_${i}`];
    if (!k) continue;
    try {
      keys.push(new ethers.Wallet(k));
    } catch {
      badIndexes.push(i);
    }
  }
  return { keys, badIndexes };
}

function toStructArg(message) {
  return {
    sourceChainId: message.sourceChainId,
    sourceContract: message.sourceContract,
    destChainId: message.destChainId,
    destContract: message.destContract,
    nonce: message.nonce,
    msgType: message.msgType,
    payload: message.payload,
  };
}

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!isAuthorizedCron(authHeader)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.RELAYER_PRIVATE_KEY) {
    return NextResponse.json({ success: false, error: "Relayer not configured" }, { status: 500 });
  }

  const threshold = Number(process.env.BRIDGE_VALIDATOR_THRESHOLD || 2);
  const { keys: validators, badIndexes } = getValidatorWallets();
  if (badIndexes.length > 0) {
    return NextResponse.json({ success: false, error: `Malformed private key in BRIDGE_VALIDATOR_PRIVATE_KEY_${badIndexes.join(", BRIDGE_VALIDATOR_PRIVATE_KEY_")}` }, { status: 500 });
  }
  if (validators.length === 0) {
    return NextResponse.json({ success: false, error: "No BRIDGE_VALIDATOR_PRIVATE_KEY_* configured" }, { status: 500 });
  }

  // Same class of bug as getValidatorWallets() above: a transient DB error here (outside the
  // per-transfer try/catch below) previously crashed the whole cron with an opaque 500.
  let pending;
  try {
    pending = await getPendingTransfersWithMessage(50);
  } catch (err) {
    return NextResponse.json({ success: false, error: `getPendingTransfersWithMessage failed: ${err.message}` }, { status: 500 });
  }
  const results = [];

  for (const doc of pending) {
    try {
      const messageHash = doc._id;

      // SQA-005 (S0): never sign a message the source chain did not emit. A client-registered document is only trusted after the
      // source transaction is looked up on the source chain and its MessageSent event matches; the chain's message replaces the client's.
      if (!doc.sourceVerified) {
        const srcChain = CHAINS[Number(doc.sourceChainId)];
        const srcProvider = srcChain?.contracts?.messenger ? getAdapter(Number(doc.sourceChainId), { useServerRpc: true }).provider : null;
        const v = await verifyMessageOnSource({ messageHash, sourceTxHash: doc.sourceTxHash, provider: srcProvider, messengerAddress: srcChain?.contracts?.messenger });
        if (!v.ok) {
          results.push({ messageHash, status: "unverified_source", reason: v.reason });
          continue;
        }
        await recordTransferInitiated({ messageHash, sourceChainId: doc.sourceChainId, destChainId: doc.destChainId, amount: doc.amount, userAddress: doc.userAddress, sourceTxHash: doc.sourceTxHash, kind: doc.kind, message: v.message }, { verified: true });
        doc.message = v.message;
      }
      if (hashBridgeMessage(doc.message).toLowerCase() !== String(messageHash).toLowerCase()) {
        results.push({ messageHash, status: "message_hash_mismatch" });
        continue;
      }

      // Each configured validator signs the raw messageId -- ethers' signMessage applies the
      // EIP-191 prefix internally, matching MessageHashUtils.toEthSignedMessageHash on-chain.
      for (const validator of validators) {
        const sig = await validator.signMessage(ethers.getBytes(messageHash));
        await recordValidatorSignature(messageHash, validator.address, sig);
      }

      const signatures = await getSignaturesFor(messageHash);
      if (signatures.length < threshold) {
        results.push({ messageHash, status: "awaiting_signatures", have: signatures.length, need: threshold });
        continue;
      }

      const destChain = CHAINS[Number(doc.destChainId)];
      if (!destChain?.contracts?.messenger) {
        results.push({ messageHash, status: "no_dest_messenger_configured" });
        continue;
      }

      const provider = getAdapter(Number(doc.destChainId), { useServerRpc: true }).provider;
      const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
      const messenger = new ethers.Contract(destChain.contracts.messenger, MESSENGER_ABI, relayer);

      await markTransferStatus(messageHash, "validating");
      const tx = await messenger.executeMessage(toStructArg(doc.message), signatures);
      await tx.wait();

      // Authoritative completion status still comes from the destination chain's own
      // MessageExecuted/MessageFailed event, picked up by cron/index-events -- this route just
      // submits the transaction.
      results.push({ messageHash, status: "submitted", txHash: tx.hash });
    } catch (err) {
      results.push({ messageHash: doc._id, status: "error", error: err.message });
    }
  }

  // Per-transfer failures are caught above and only land in this response body, which Vercel does
  // not retain -- log them so a transfer that never relays is visible in the function logs.
  console.log("[relay-messages]", JSON.stringify({ pending: pending.length, threshold, validators: validators.length, results }));
  return NextResponse.json({ success: true, results });
}
