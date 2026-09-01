"use client";

// src/lib/nftDiscovery.js
//
// On-chain NFT discovery — ERC-721 (+ Enumerable extension) only.
//
// HONEST SCOPE: no NFT-indexer credentials (Alchemy/Moralis/thirdweb, etc.)
// are configured anywhere in this project — auto-discovering "every NFT a
// wallet owns across every collection" fundamentally needs one, the same
// "ships with the interface real but the provider not yet configured"
// situation the Backup mechanism's Filebase credentials started in. So
// this asks for a specific collection's contract address rather than
// silently pretending to be omniscient. Real limitation, stated directly:
// ERC-1155 collections (no owner-indexed enumeration in the standard) and
// non-Enumerable ERC-721 collections (a real minority, but they exist)
// aren't discoverable this way — both fail with a clear, honest message,
// never a silent empty result presented as "you own nothing here."
//
// tokenURI resolution mirrors page.js's existing dual-gateway-with-
// fallback convention for ipfs:// CIDs (cloudflare-ipfs.com, then
// gateway.pinata.cloud) — same real gateways this app already trusts.

import { ethers } from "ethers";

const ERC721_ENUMERABLE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
];

const IFACE_ERC721 = "0x80ac58cd";
const IFACE_ERC721_ENUMERABLE = "0x780e9d63";

function resolveIpfsUri(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) return `https://cloudflare-ipfs.com/ipfs/${uri.slice("ipfs://".length)}`;
  return uri;
}

async function fetchWithGatewayFallback(uri) {
  const primary = resolveIpfsUri(uri);
  try {
    const res = await fetch(primary);
    if (res.ok) return res;
  } catch {
    // fall through to the pinata gateway below
  }
  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice("ipfs://".length);
    const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
    if (res.ok) return res;
  }
  throw new Error(`Could not fetch ${uri} from either gateway.`);
}

/** Confirms the contract is actually a standard, enumerable ERC-721 before
 *  attempting discovery — a contract that doesn't support these interfaces
 *  fails with a clear reason instead of a confusing revert deep in the
 *  discovery loop. */
export async function checkNftContractSupport(contractAddress, provider) {
  const contract = new ethers.Contract(contractAddress, ERC721_ENUMERABLE_ABI, provider);
  try {
    const [isErc721, isEnumerable] = await Promise.all([
      contract.supportsInterface(IFACE_ERC721),
      contract.supportsInterface(IFACE_ERC721_ENUMERABLE),
    ]);
    if (!isErc721) return { supported: false, reason: "This contract doesn't implement the ERC-721 NFT standard." };
    if (!isEnumerable) return { supported: false, reason: "This ERC-721 contract doesn't implement Enumerable, so Inaya can't list which token IDs you own without a third-party indexer (not configured). ERC-1155 collections aren't supported yet either." };
    let name = null, symbol = null;
    try { [name, symbol] = await Promise.all([contract.name(), contract.symbol()]); } catch { /* optional metadata, non-fatal */ }
    return { supported: true, name, symbol };
  } catch (err) {
    return { supported: false, reason: `Could not read this contract on-chain: ${err.shortMessage || err.message}` };
  }
}

/** Discovers every token ownerAddress owns in contractAddress (Enumerable
 *  ERC-721 only, see module header) and resolves each one's real metadata
 *  (name/description/image) from its tokenURI. Returns
 *  [{tokenId, tokenURI, name, description, image}] — a token whose
 *  metadata fails to resolve still appears, with metadataError set, rather
 *  than being silently dropped. */
export async function discoverOwnedTokens({ contractAddress, ownerAddress, provider }) {
  const contract = new ethers.Contract(contractAddress, ERC721_ENUMERABLE_ABI, provider);
  const balance = await contract.balanceOf(ownerAddress);
  const count = Number(balance);
  if (count === 0) return [];

  const tokenIds = await Promise.all(
    Array.from({ length: count }, (_, i) => contract.tokenOfOwnerByIndex(ownerAddress, i))
  );

  return Promise.all(
    tokenIds.map(async (tokenIdBn) => {
      const tokenId = tokenIdBn.toString();
      const base = { tokenId, contractAddress };
      let uri;
      try {
        uri = await contract.tokenURI(tokenIdBn);
      } catch (err) {
        return { ...base, tokenURI: null, name: `Token #${tokenId}`, metadataError: `tokenURI() reverted: ${err.shortMessage || err.message}` };
      }
      try {
        const res = await fetchWithGatewayFallback(uri);
        const meta = await res.json();
        return {
          ...base,
          tokenURI: uri,
          name: meta.name || `Token #${tokenId}`,
          description: meta.description || null,
          image: resolveIpfsUri(meta.image),
        };
      } catch (err) {
        return { ...base, tokenURI: uri, name: `Token #${tokenId}`, metadataError: `Metadata fetch failed: ${err.message}` };
      }
    })
  );
}
