// app/api/egress-unlock-status/route.js
//
// GET  /api/egress-unlock-status?fileHash=0x...
//   Read-only. Says whether this file is already unlocked by a paid egress
//   checkout, and reports this month's included-retrieval allowance.
//
// POST /api/egress-unlock-status   Body: { fileHash }
//   Claims one retrieval of the file against this month's included
//   allowance (retrieval up to the customer's stored volume is included each
//   month -- see src/lib/egressAllowance.js). Returns unlocked: true if it
//   fit, otherwise unlocked: false and the frontend sends the customer
//   through create-egress-checkout-session.
//
// Checked before a card customer's Reconstruct actually fetches/decrypts.
//
// Identity comes ONLY from the inaya_customer_email cookie -- see
// payg-assets/route.js's header comment for why a client-supplied ?email=
// is no longer accepted as an alternative (it let anyone query any other
// customer's unlock status).

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../lib/mongodb";
import { claimIncludedRetrieval, getAllowance } from "../../../lib/egressAllowance.js";

const allowanceView = ({ month, storedBytes, usedBytes, remainingBytes }) => ({ month, storedBytes, usedBytes, remainingBytes });

async function paidUnlock(db, email, fileHash) {
  return db.collection("egress_unlocks").findOne({ email: email.toLowerCase(), fileHash });
}

export async function GET(req) {
  const email = req.cookies.get("inaya_customer_email")?.value;
  const fileHash = req.nextUrl.searchParams.get("fileHash");

  if (!email || !fileHash) {
    return NextResponse.json({ error: "No inaya_customer_email cookie set, or fileHash is missing" }, { status: 401 });
  }

  const { db } = await connectToDatabase();
  const [record, allowance] = await Promise.all([paidUnlock(db, email, fileHash), getAllowance(db, email)]);

  return NextResponse.json({ unlocked: !!record, allowance: allowanceView(allowance) });
}

export async function POST(req) {
  const email = req.cookies.get("inaya_customer_email")?.value;
  const { fileHash } = await req.json().catch(() => ({}));

  if (!email || !fileHash) {
    return NextResponse.json({ error: "No inaya_customer_email cookie set, or fileHash is missing" }, { status: 401 });
  }

  const { db } = await connectToDatabase();
  if (await paidUnlock(db, email, fileHash)) {
    return NextResponse.json({ unlocked: true, included: false, allowance: allowanceView(await getAllowance(db, email)) });
  }

  const claim = await claimIncludedRetrieval(db, email, fileHash);
  return NextResponse.json({ unlocked: claim.granted, included: claim.granted, reason: claim.reason, allowance: allowanceView(claim) });
}
