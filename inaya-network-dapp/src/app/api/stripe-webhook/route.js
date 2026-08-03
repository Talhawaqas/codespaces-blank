// app/api/stripe-webhook/route.js
//
// Fires when Stripe confirms a card payment. Branches on
// session.metadata.checkoutType:
//   - "corporate_reserve" (or unset, for backward compatibility) â€”
//     RevenueRouter.processCorporateInvoice() + CorporateEscrow.createEscrow()
//   - "payg_upload" â€” InayaCustody.batchRegisterAssets() for a single
//     already-encrypted-and-pinned file
// Both are signed by the server's own treasury wallet instead of the
// customer's, since the customer never connects one. Entitlements are
// tracked in MongoDB, keyed by email from Stripe, not by a wallet address.

import Stripe from "stripe";
import { ethers } from "ethers";
import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../lib/mongodb";

// Both settlement paths can involve multiple on-chain transactions with
// confirmations â€” this can easily exceed Vercel's default function timeout.
// 60s is the max Hobby allows; Pro allows higher (up to 300s standard).
export const maxDuration = 60;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const REVENUE_ROUTER_ADDRESS = process.env.NEXT_PUBLIC_REVENUE_ROUTER_ADDRESS || "0x76B0d41f5c02b34FEa36E5F23D3D3d34C7243256";
const CORPORATE_ESCROW_ADDRESS = process.env.CORPORATE_ESCROW_ADDRESS;
const USDT_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_MOCK_USDT_ADDRESS;
const INAYA_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_INAYA_TOKEN_ADDRESS;
const OPERATOR_POOL_ADDRESS = process.env.OPERATOR_POOL_ADDRESS;
const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888"; // InayaCustody â€” matches page.js's liveContractAddress
const TREASURY_WALLET_PRIVATE_KEY = process.env.TREASURY_WALLET_PRIVATE_KEY; // server-only, never exposed to the client

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const ROUTER_ABI = ["function processCorporateInvoice(uint256 _usdtAmount) external"];
const ESCROW_ABI = ["function createEscrow(address beneficiary, address operatorPool, uint256 amount) external"];
const CUSTODY_ABI = [
  "function batchRegisterAssets(bytes32[] fileHashes, uint256[] fileSizes, string[] shardACIDs, string[] shardBCIDs) external",
  "function usdtFeePerGB() public view returns (uint256)",
  "function inayaFeePerGB() public view returns (uint256)",
];

const TIER_TERM_MS = 365 * 24 * 60 * 60 * 1000; // 1 year, matches CORPORATE_TERM_MS in page.js
const GB = 1073741824n;

export async function POST(req) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Stripe signature verification failed:", err.message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ received: true }); // ignore anything else
  }

  const session = event.data.object;
  const checkoutType = session.metadata?.checkoutType || "corporate_reserve";
  const customerEmail = session.customer_details?.email;

  if (!customerEmail) {
    console.error("Missing email on completed session:", session.id);
    return NextResponse.json({ error: "Missing email" }, { status: 400 });
  }

  try {
    if (checkoutType === "payg_upload") {
      const result = await settlePaygUpload(session, customerEmail);
      return NextResponse.json({ received: true, ...result });
    } else if (checkoutType === "egress_unlock") {
      const result = await settleEgressUnlock(session, customerEmail);
      return NextResponse.json({ received: true, ...result });
    } else {
      const result = await settleCorporateReserve(session, customerEmail);
      return NextResponse.json({ received: true, ...result });
    }
  } catch (err) {
    // Payment already succeeded at this point â€” on-chain settlement failing
    // needs to alert someone, not silently 500 and lose the customer's money's worth.
    console.error(`[FAILED] On-chain settlement failed after successful payment (${checkoutType}) for ${customerEmail}:`, err);
    return NextResponse.json({ error: "On-chain settlement failed", details: err.message }, { status: 500 });
  }
}

// ============================================================
// Corporate Reserve â€” RevenueRouter + CorporateEscrow
// ============================================================
async function settleCorporateReserve(session, customerEmail) {
  const tier = session.metadata?.tier;
  const amountUsd = session.amount_total / 100;
  if (!tier) throw new Error("Missing tier in session metadata");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const treasuryWallet = new ethers.Wallet(TREASURY_WALLET_PRIVATE_KEY, provider);
  const usdt = new ethers.Contract(USDT_TOKEN_ADDRESS, ERC20_ABI, treasuryWallet);

  const decimals = await usdt.decimals();
  const invoiceAmountWei = ethers.parseUnits(String(amountUsd), decimals);

  // 1. Approve + settle via RevenueRouter â€” same call page.js makes with a connected wallet.
  const routerAllowance = await usdt.allowance(treasuryWallet.address, REVENUE_ROUTER_ADDRESS);
  if (routerAllowance < invoiceAmountWei) {
    const approveTx = await usdt.approve(REVENUE_ROUTER_ADDRESS, ethers.MaxUint256);
    await approveTx.wait();
  }
  const router = new ethers.Contract(REVENUE_ROUTER_ADDRESS, ROUTER_ABI, treasuryWallet);
  const routerTx = await router.processCorporateInvoice(invoiceAmountWei);
  await routerTx.wait();

  // 2. Escrow the 39% COGS share for the standard 12-month vesting schedule.
  const cogsAmountWei = (invoiceAmountWei * 39n) / 100n;
  const escrowAllowance = await usdt.allowance(treasuryWallet.address, CORPORATE_ESCROW_ADDRESS);
  if (escrowAllowance < cogsAmountWei) {
    const approveEscrowTx = await usdt.approve(CORPORATE_ESCROW_ADDRESS, ethers.MaxUint256);
    await approveEscrowTx.wait();
  }
  const escrow = new ethers.Contract(CORPORATE_ESCROW_ADDRESS, ESCROW_ABI, treasuryWallet);
  const escrowTx = await escrow.createEscrow(treasuryWallet.address, OPERATOR_POOL_ADDRESS, cogsAmountWei);
  await escrowTx.wait();

  // This is the piece localStorage can't do for a card customer:
  // persist the entitlement in a real database, keyed by email.
  const { db } = await connectToDatabase();
  const now = Date.now();
  await db.collection("corporate_plans").updateOne(
    { email: customerEmail.toLowerCase() },
    {
      $set: {
        email: customerEmail.toLowerCase(),
        tier,
        amountUsd,
        stripeSessionId: session.id,
        routerTxHash: routerTx.hash,
        escrowTxHash: escrowTx.hash,
        activatedAt: now,
        expiresAt: now + TIER_TERM_MS,
      },
    },
    { upsert: true }
  );

  console.log(`[OK] Corporate plan activated on-chain for ${customerEmail}: ${tier} (router tx ${routerTx.hash})`);
  return { routerTxHash: routerTx.hash, escrowTxHash: escrowTx.hash };
}

// ============================================================
// Egress Unlock â€” no on-chain interaction. Retrieval has no gate on the
// Custody contract itself (confirmed: assets() is a public read), so
// paying here just records permission in the database â€” the frontend
// checks this record before it lets a card customer proceed to actually
// fetch shards and decrypt.
// ============================================================
async function settleEgressUnlock(session, customerEmail) {
  const { fileHash, filename, inayaPriceUsdtAtCharge } = session.metadata || {};
  if (!fileHash) throw new Error("Missing fileHash in session metadata");

  const { db } = await connectToDatabase();
  await db.collection("egress_unlocks").updateOne(
    { email: customerEmail.toLowerCase(), fileHash },
    {
      $set: {
        email: customerEmail.toLowerCase(),
        fileHash,
        filename,
        amountUsd: session.amount_total / 100,
        inayaPriceUsdtAtCharge,
        stripeSessionId: session.id,
        unlockedAt: Date.now(),
      },
    },
    { upsert: true }
  );

  console.log(`[OK] Egress unlocked for ${customerEmail}: ${filename} (${fileHash})`);
  return { unlocked: true };
}

// ============================================================
// PAYG Upload — InayaCustody.batchRegisterAssets (single file)
// ============================================================
async function settlePaygUpload(session, customerEmail) {
  const { filename, sizeBytes, cidAlpha, cidBeta, fileHash } = session.metadata || {};

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const treasuryWallet = new ethers.Wallet(TREASURY_WALLET_PRIVATE_KEY, provider);
  const custodyRead = new ethers.Contract(CUSTODY_ADDRESS, CUSTODY_ABI, provider);
  const custody = new ethers.Contract(CUSTODY_ADDRESS, CUSTODY_ABI, treasuryWallet);

  const [usdtFeePerGB, inayaFeePerGB] = await Promise.all([
    custodyRead.usdtFeePerGB(),
    custodyRead.inayaFeePerGB(),
  ]);
  const sizeBigInt = BigInt(sizeBytes);
  const usdtFee = (sizeBigInt * usdtFeePerGB) / GB;
  const inayaFee = (sizeBigInt * inayaFeePerGB) / GB;

  // Custody charges BOTH USDT and INAYA per GB â€” approve whichever is nonzero.
  if (usdtFee > 0n) {
    const usdt = new ethers.Contract(USDT_TOKEN_ADDRESS, ERC20_ABI, treasuryWallet);
    const allowance = await usdt.allowance(treasuryWallet.address, CUSTODY_ADDRESS);
    if (allowance < usdtFee) {
      const approveTx = await usdt.approve(CUSTODY_ADDRESS, ethers.MaxUint256);
      await approveTx.wait();
    }
  }
  if (inayaFee > 0n) {
    const inaya = new ethers.Contract(INAYA_TOKEN_ADDRESS, ERC20_ABI, treasuryWallet);
    const allowance = await inaya.allowance(treasuryWallet.address, CUSTODY_ADDRESS);
    if (allowance < inayaFee) {
      const approveTx = await inaya.approve(CUSTODY_ADDRESS, ethers.MaxUint256);
      await approveTx.wait();
    }
  }

  const registerTx = await custody.batchRegisterAssets([fileHash], [sizeBytes], [cidAlpha], [cidBeta]);
  await registerTx.wait();

  const { db } = await connectToDatabase();
  await db.collection("payg_assets").insertOne({
    email: customerEmail.toLowerCase(),
    filename,
    fileHash,
    sizeBytes: Number(sizeBytes),
    stripeSessionId: session.id,
    txHash: registerTx.hash,
    uploadedAt: Date.now(),
  });

  console.log(`[OK] PAYG asset registered on-chain for ${customerEmail}: ${filename} (tx ${registerTx.hash})`);
  return { registerTxHash: registerTx.hash };
}