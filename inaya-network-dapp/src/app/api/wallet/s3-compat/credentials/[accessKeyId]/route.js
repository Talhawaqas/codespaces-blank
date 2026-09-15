// DELETE /api/wallet/s3-compat/credentials/:accessKeyId
// Body: { walletAddress, message, signature, timestamp }, same
// verifyMetadataAuth gate as the POST route (action: "s3_credential_revoke").
import { NextResponse } from "next/server";
import { verifyMetadataAuth } from "../../../../../../lib/metadata-auth.js";
import { revokeS3Credential } from "../../../../../../lib/s3-compat/credentials.js";

export async function DELETE(req, { params }) {
  try {
    const { walletAddress, message, signature, timestamp } = await req.json();
    if (!walletAddress) return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });

    verifyMetadataAuth({ action: "s3_credential_revoke", resourceId: params.accessKeyId, address: walletAddress, message, signature, timestamp });

    const revoked = await revokeS3Credential({ owner: { type: "wallet", walletAddress }, accessKeyId: params.accessKeyId });
    if (!revoked) return NextResponse.json({ error: "Credential not found or already revoked." }, { status: 404 });
    return NextResponse.json({ revoked: true });
  } catch (err) {
    console.error("wallet/s3-compat/credentials/[accessKeyId] DELETE failed:", err);
    return NextResponse.json({ error: err.message || "Could not revoke the credential." }, { status: 400 });
  }
}
