// app/api/nft/backups/route.js
//
// GET /api/nft/backups?address=&chainId=&contractAddress=
// Public read (no signature needed) — NFT ownership is already public
// on-chain data, and this only ever returns what a wallet itself recorded
// as backed up, never anything sensitive. Used by the NFT Vault page to
// show a "Backed up" badge on tokens already saved, instead of asking
// every visit.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get("address");
    const chainId = searchParams.get("chainId");
    const contractAddress = searchParams.get("contractAddress");
    if (!address) return NextResponse.json({ error: "address is required." }, { status: 400 });

    const filter = { owner: address.toLowerCase() };
    if (chainId) filter.chainId = chainId;
    if (contractAddress) filter.contractAddress = contractAddress.toLowerCase();

    const { db } = await connectToDatabase();
    const backups = await db.collection("nft_backups").find(filter).toArray();
    return NextResponse.json({ backups });
  } catch (err) {
    console.error("nft/backups GET failed:", err);
    return NextResponse.json({ error: "Could not load backups." }, { status: 500 });
  }
}
