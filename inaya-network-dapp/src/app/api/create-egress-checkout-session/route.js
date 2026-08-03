// app/api/create-egress-checkout-session/route.js
//
// POST /api/create-egress-checkout-session
// Body: { fileHash, filename, sizeBytes }
//
// Card-based egress unlock — the whitepaper's "5 INAYA per 0.5TB" rate,
// converted to USD using the LIVE spot price read directly from your
// PancakeSwap testnet pool (the pair contract IS the LP token address —
// no separate lookup needed). No on-chain gate exists for egress on the
// Custody contract itself (confirmed: retrieval is a public read), so
// this checkout's only job is to record "this email paid to retrieve
// this file" — see stripe-webhook's egress_unlock branch.
//
// Note: this pool is small. A single large swap can move the spot price
// meaningfully between requests — that's realistic AMM behavior, not a bug.

import Stripe from "stripe";
import { ethers } from "ethers";
import { NextResponse } from "next/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const INAYA_USDT_PAIR_ADDRESS = "0xbf6194994a5fcdebe982026f029da5f50a255359"; // your seeded PancakeSwap testnet pool
const USDT_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_MOCK_USDT_ADDRESS;
const INAYA_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_INAYA_TOKEN_ADDRESS;

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const EGRESS_INAYA_PER_UNIT = 5;
const EGRESS_UNIT_BYTES = 549755813888n; // 0.5 TB, matching the whitepaper's "5 INAYA per 0.5TB" rate
const MIN_CHARGE_CENTS = 50; // Stripe's practical USD minimum

/** Reads the pool's current reserves and returns the live INAYA price in USDT. */
async function getLiveInayaPriceUsdt(provider) {
  const pair = new ethers.Contract(INAYA_USDT_PAIR_ADDRESS, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = (await pair.token0()).toLowerCase();

  const isInayaToken0 = token0 === INAYA_TOKEN_ADDRESS.toLowerCase();
  const inayaReserve = isInayaToken0 ? reserve0 : reserve1;
  const usdtReserve = isInayaToken0 ? reserve1 : reserve0;

  if (inayaReserve === 0n) throw new Error("Pool has zero INAYA reserve — cannot price.");

  // Both tokens use 18 decimals here, so a straight ratio of raw reserves is the spot price.
  return parseFloat(ethers.formatUnits(usdtReserve, 18)) / parseFloat(ethers.formatUnits(inayaReserve, 18));
}

export async function POST(req) {
  try {
    const { fileHash, filename, sizeBytes } = await req.json();
    if (!fileHash || !filename || !sizeBytes) {
      return NextResponse.json({ error: "fileHash, filename, and sizeBytes are all required." }, { status: 400 });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const inayaPriceUsdt = await getLiveInayaPriceUsdt(provider);

    const egressUnits = Number(sizeBytes) / Number(EGRESS_UNIT_BYTES);
    const inayaFee = egressUnits * EGRESS_INAYA_PER_UNIT;
    const usdFee = inayaFee * inayaPriceUsdt;
    const rawCents = Math.round(usdFee * 100);
    const flooredByMinimum = rawCents < MIN_CHARGE_CENTS;
    const cents = Math.max(rawCents, MIN_CHARGE_CENTS);

    // User-facing framing: never show the "0.0000 INAYA" artifact of a tiny
    // real fee getting rounded to near-zero — that reads as "why am I paying
    // for nothing" instead of communicating an intentional minimum. Only show
    // the actual per-file calculation once it's large enough to be meaningful
    // (i.e. the real fee already exceeds the floor on its own).
    const userDescription = flooredByMinimum
      ? "Minimum Retrieval Fee — covers network processing for small files"
      : `${inayaFee.toFixed(4)} INAYA at live pool price (${inayaPriceUsdt.toFixed(4)} USDT/INAYA)`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `Inaya Network — Egress: ${filename}`,
              description: userDescription,
            },
            unit_amount: cents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        checkoutType: "egress_unlock",
        fileHash,
        filename,
        inayaPriceUsdtAtCharge: inayaPriceUsdt.toFixed(6),
        // Dev-facing only — never shown to the customer, but visible in the
        // Stripe Dashboard/webhook logs so the real math is always auditable
        // even when the customer-facing description says "Minimum Retrieval Fee".
        devRealInayaFee: inayaFee.toFixed(8),
        devRealUsdFee: usdFee.toFixed(8),
        devFlooredByMinimum: String(flooredByMinimum),
      },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=success&type=egress&fileHash=${encodeURIComponent(fileHash)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/?checkout=cancelled`,
    });

    return NextResponse.json({ url: session.url, quotedUsd: (cents / 100).toFixed(2), inayaPriceUsdt });
  } catch (err) {
    console.error("create-egress-checkout-session error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}