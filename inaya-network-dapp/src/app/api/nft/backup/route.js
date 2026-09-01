// app/api/nft/backup/route.js
//
// POST /api/nft/backup
// Body: { chainId, contractAddress, tokenId, name, imageCid, metadataCid, address, message, signature, timestamp }
//
// Records that this wallet backed up one NFT's metadata/image to Inaya's
// encrypted storage (the actual encrypt+shard+pin already happened
// client-side via clientCrypto.js's encryptAndShardFile — this route only
// records the resulting CIDs). Two checks, both fail closed:
//   1. verifyMetadataAuth() — same generic signature framework
//      metadata-auth.js already uses for file-sharing routes (action:
//      "backupNft" here). Proves the caller controls `address`.
//   2. A real on-chain ownerOf(tokenId) read against the NFT contract —
//      proves `address` actually owns this specific token right now, not
//      just that they control SOME wallet. Mirrors verifyOnChainFileOwner's
//      exact spirit (metadata-auth.js) for a different contract shape.

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth } from "../../../../lib/metadata-auth";

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const OWNER_OF_ABI = ["function ownerOf(uint256 tokenId) view returns (address)"];

export async function POST(req) {
  try {
    const { chainId, contractAddress, tokenId, name, imageCid, metadataCid, address, message, signature, timestamp } = await req.json();
    if (!chainId || !contractAddress || tokenId === undefined || tokenId === null) {
      return NextResponse.json({ error: "chainId, contractAddress, and tokenId are required." }, { status: 400 });
    }

    const resourceId = `${chainId}:${String(contractAddress).toLowerCase()}:${tokenId}`;
    verifyMetadataAuth({ action: "backupNft", resourceId, extra: { imageCid: imageCid || "", metadataCid: metadataCid || "" }, address, message, signature, timestamp });

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const nft = new ethers.Contract(contractAddress, OWNER_OF_ABI, provider);
    const owner = await nft.ownerOf(tokenId);
    if (owner.toLowerCase() !== address.toLowerCase()) {
      return NextResponse.json({ error: "Signer is not the current on-chain owner of this token." }, { status: 403 });
    }

    const { db } = await connectToDatabase();
    const now = new Date().toISOString();
    await db.collection("nft_backups").updateOne(
      { resourceId },
      {
        $set: {
          resourceId, chainId, contractAddress: contractAddress.toLowerCase(), tokenId: String(tokenId),
          owner: address.toLowerCase(), name: name || null, imageCid: imageCid || null, metadataCid: metadataCid || null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    const record = await db.collection("nft_backups").findOne({ resourceId });
    return NextResponse.json(record);
  } catch (err) {
    console.error("nft/backup POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
