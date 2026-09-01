"use client";

// src/lib/nftBackupAuth.js
//
// Client-side message-building + signing for the "backupNft" action —
// mirrors custody-sdk/src/metadata.js's buildMetadataMessage()/
// signMetadataAction() message format EXACTLY (same "Inaya Metadata
// Action\naction: ...\nresourceId: ...\n<extra>\ntimestamp: ..." shape),
// so src/lib/metadata-auth.js's existing verifyMetadataAuth() can verify
// it server-side unmodified — this is the SAME generic, already-deployed
// signature framework the file-sharing metadata routes use, not a new
// auth scheme. Not imported from the SDK directly because the SDK's
// signMetadataAction is unexported and tied to the SDK's own connection
// object shape; the main dApp already drives its own ethers.js
// BrowserProvider/signer directly (see app/page.js), so this is a small,
// local re-implementation of the same 8-line message format instead.

function buildBackupMessage({ resourceId, extra }) {
  const timestamp = Date.now();
  const lines = ["Inaya Metadata Action", "action: backupNft", `resourceId: ${resourceId}`];
  if (extra) for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${String(value)}`);
  lines.push(`timestamp: ${timestamp}`);
  return { message: lines.join("\n"), timestamp };
}

/** Signs proof-of-wallet-control for one NFT backup record. `signer` is an
 *  already-connected ethers.Signer (from provider.getSigner()) — this
 *  module never connects a wallet itself. Returns the
 *  {address, message, signature, timestamp} tuple the backend route
 *  verifies via metadata-auth.js's verifyMetadataAuth(). */
export async function signNftBackup({ signer, chainId, contractAddress, tokenId, imageCid, metadataCid }) {
  const address = await signer.getAddress();
  const resourceId = `${chainId}:${contractAddress.toLowerCase()}:${tokenId}`;
  const { message, timestamp } = buildBackupMessage({ resourceId, extra: { imageCid: imageCid || "", metadataCid: metadataCid || "" } });
  const signature = await signer.signMessage(message);
  return { address, message, signature, timestamp, resourceId };
}
