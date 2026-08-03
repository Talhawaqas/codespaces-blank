// app/api/create-payg-checkout-session/route.js
//
// POST /api/create-payg-checkout-session
// Body: { filename, sizeBytes, cidAlpha, cidBeta, fileHash }
//
// Card-based Pay-As-You-Go upload — the counterpart to
// create-checkout-session (Corporate Reserve) but for a single already
// encrypted-and-pinned file instead of a fixed annual tier. The client
// runs the exact same prepareShardedFile()/computeFileHash() pipeline
// page.js already uses for wallet uploads (no wallet needed for that
// part), gets cidAlpha/cidBeta/fileHash back, and hands them here to
// get a Stripe checkout for the live per-GB fee. On-chain registration
// happens server-side afterward — see stripe-webhook's payg_upload branch.

import Stripe from "stripe";
import { ethers } from "ethers";
import { NextResponse } from "next/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888"; // InayaCustody — matches page.js's liveContractAddress
const CUSTODY_READ_ABI = ["function usdtFeePerGB() public view returns (uint256)"];

const GB = 1073741824n;
const TB = GB * 1024n;
const MIN_CHARGE_CENTS = 450; // flat $4.50 covers anything up to 1TB — card customers only, see note below

export async function POST(req) {
  try {
    const { filename, sizeBytes, cidAlpha, cidBeta, fileHash } = await req.json();

    if (!filename || !sizeBytes || !cidAlpha || !cidBeta || !fileHash) {
      return NextResponse.json({ error: "filename, sizeBytes, cidAlpha, cidBeta, and fileHash are all required." }, { status: 400 });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const custody = new ethers.Contract(CUSTODY_ADDRESS, CUSTODY_READ_ABI, provider);

    let usdtFeePerGB;
    try {
      usdtFeePerGB = await custody.usdtFeePerGB();
    } catch {
      usdtFeePerGB = 100000000000000000n; // same 0.1-token fallback page.js uses if the read fails
    }

    const usdtFeeWei = (BigInt(sizeBytes) * usdtFeePerGB) / GB;
    const usdtFeeFloat = parseFloat(ethers.formatUnits(usdtFeeWei, 18));
    const linearCents = Math.round(usdtFeeFloat * 100);

    // Billing rule (card customers only — see note in stripe-webhook.js):
    //   < 1 GB   → flat $0.50 (testnet-era test fee, keeps repeated small-file
    //              testing cheap instead of paying the full $4.50 minimum)
    //   1GB–1TB  → flat $4.50
    //   > 1TB    → scales at the same $4.50/TB rate
    // None of this changes what the contract actually charges the treasury
    // wallet on-chain (that's the real linear per-GB fee, correctly set via
    // setFees to ~4.5 USDT/TB) — this only changes what Stripe charges the
    // customer, so these tiers are a billing decision, not an on-chain rule.
    const sizeGB = Number(sizeBytes) / Number(GB);
    const sizeTB = Number(sizeBytes) / Number(TB);
    const TESTNET_SMALL_FILE_CENTS = 50; // $0.50, for anything under 1GB

    let tierCents;
    if (sizeGB < 1) {
      tierCents = TESTNET_SMALL_FILE_CENTS;
    } else {
      tierCents = Math.round(Math.max(1, sizeTB) * MIN_CHARGE_CENTS);
    }
    const cents = Math.max(linearCents, tierCents, TESTNET_SMALL_FILE_CENTS);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Inaya Network — PAYG Storage: ${filename}`,
              description: `${(Number(sizeBytes) / 1073741824).toFixed(4)} GB, billed at the live per-GB rate.`,
            },
            unit_amount: cents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        checkoutType: "payg_upload",
        filename,
        sizeBytes: String(sizeBytes),
        cidAlpha,
        cidBeta,
        fileHash,
      },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=success&type=payg&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=cancelled`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("create-payg-checkout-session error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}