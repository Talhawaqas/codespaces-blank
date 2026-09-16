// app/api/wallet/s3-compat/credentials/route.js
//
// Wallet-side S3/Azure-compatibility credential management -- lives in the
// dApp's own wallet-authenticated API namespace, so a wallet-only user
// never has to join an org or touch Business Workspace to get an S3
// credential for their personal vault.
//
// POST — signature-gated via verifyMetadataAuth (same pattern as every
//   other mutating metadata/* route: message = "Inaya Metadata Action\n
//   action: s3_credential_issue\nresourceId: <walletAddress>\ntimestamp: <ts>").
//   Body: { walletAddress, message, signature, timestamp, label? }.
// GET — unauthenticated read scoped by the walletAddress query param, same
//   convention as metadata/list-files/route.js (never returns secrets).
// DELETE — see [accessKeyId]/route.js, same signature gate.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../../lib/mongodb.js";
import { verifyMetadataAuth } from "../../../../../lib/metadata-auth.js";
import { issueS3Credential, listS3Credentials, ensureS3CompatIndexes } from "../../../../../lib/s3-compat/credentials.js";

export async function POST(req) {
  try {
    const { walletAddress, message, signature, timestamp, label, scope } = await req.json();
    if (!walletAddress) return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });

    verifyMetadataAuth({ action: "s3_credential_issue", resourceId: walletAddress, address: walletAddress, message, signature, timestamp });

    const { db } = await connectToDatabase();
    await ensureS3CompatIndexes(db);

    const result = await issueS3Credential({ owner: { type: "wallet", walletAddress }, label, actorEmail: null, scope });
    return NextResponse.json({
      ...result,
      endpoint: "/api/s3",
      region: "inaya",
      note: "Use this endpoint with any S3-compatible tool: --endpoint-url pointed at this host's /api/s3 path.",
    });
  } catch (err) {
    console.error("wallet/s3-compat/credentials POST failed:", err);
    return NextResponse.json({ error: err.message || "Could not create the S3-compatible credential." }, { status: 400 });
  }
}

export async function GET(req) {
  try {
    const walletAddress = new URL(req.url).searchParams.get("walletAddress");
    if (!walletAddress) return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });
    const result = await listS3Credentials({ type: "wallet", walletAddress });
    return NextResponse.json({ credentials: result });
  } catch (err) {
    console.error("wallet/s3-compat/credentials GET failed:", err);
    return NextResponse.json({ error: "Could not list S3-compatible credentials." }, { status: 500 });
  }
}
