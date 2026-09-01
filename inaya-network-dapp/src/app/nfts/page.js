"use client";

// app/nfts/page.js
//
// NFT Vault — discover the NFTs your wallet owns (ERC-721 + Enumerable
// only, see nftDiscovery.js's header for the honest scope boundary: no
// NFT-indexer credentials are configured, so this asks for a specific
// collection's contract address rather than pretending to auto-discover
// everything) and back their metadata/image up to Inaya's own encrypted,
// redundant storage.
//
// The backup itself reuses 100% existing infrastructure: clientCrypto.js's
// encryptAndShardFile() (the same AES-GCM-256 + dual-Pinata-shard pipeline
// every other upload in this app already uses) and metadata-auth.js's
// existing wallet-signature verification framework (nftBackupAuth.js's
// signNftBackup() builds the exact same message shape metadata.js's
// buildMetadataMessage() does) — no new crypto, no new auth scheme.
//
// New, isolated route rather than extending page.js or bridge/page.js,
// same "don't touch the giant existing files" precedent bridge/page.js's
// own header comment already established.

import { useState, useCallback } from "react";
import { ethers } from "ethers";
import { checkNftContractSupport, discoverOwnedTokens } from "@/lib/nftDiscovery";
import { encryptAndShardFile } from "@/lib/clientCrypto";
import { signNftBackup } from "@/lib/nftBackupAuth";

const BSC_TESTNET_CHAIN_ID = "97";

function getBrowserProvider() {
  if (typeof window === "undefined" || !window.ethereum) return null;
  return new ethers.BrowserProvider(window.ethereum);
}

async function urlToFile(url, filename, mimeFallback) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch ${url}`);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || mimeFallback });
}

export default function NftVaultPage() {
  const [account, setAccount] = useState(null);
  const [contractAddress, setContractAddress] = useState("");
  const [contractInfo, setContractInfo] = useState(null);
  const [tokens, setTokens] = useState(null);
  const [backedUp, setBackedUp] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [passkey, setPasskey] = useState("");
  const [backingUp, setBackingUp] = useState(null); // tokenId currently in flight

  const connect = useCallback(async () => {
    const provider = getBrowserProvider();
    if (!provider) {
      setError("No injected wallet found (MetaMask etc.)");
      return;
    }
    const accounts = await provider.send("eth_requestAccounts", []);
    setAccount(accounts[0]);
  }, []);

  const loadBackedUpSet = useCallback(async (owner, contract) => {
    try {
      const res = await fetch(`/api/nft/backups?address=${owner}&contractAddress=${contract}`);
      const data = await res.json();
      setBackedUp(new Set((data.backups || []).map((b) => b.tokenId)));
    } catch {
      // best-effort — an unknown backup status just means the badge doesn't show yet, not a hard failure
    }
  }, []);

  const loadNfts = useCallback(async () => {
    if (!account || !contractAddress.trim()) return;
    setLoading(true);
    setError("");
    setTokens(null);
    setContractInfo(null);
    try {
      const provider = getBrowserProvider();
      const support = await checkNftContractSupport(contractAddress.trim(), provider);
      setContractInfo(support);
      if (!support.supported) return;

      const owned = await discoverOwnedTokens({ contractAddress: contractAddress.trim(), ownerAddress: account, provider });
      setTokens(owned);
      await loadBackedUpSet(account, contractAddress.trim());
    } catch (err) {
      setError(err.shortMessage || err.message);
    } finally {
      setLoading(false);
    }
  }, [account, contractAddress, loadBackedUpSet]);

  const backUpToken = useCallback(async (token) => {
    if (!passkey) {
      setError("Enter a passkey first — it encrypts the backup the same way every other Inaya upload is encrypted.");
      return;
    }
    setBackingUp(token.tokenId);
    setError("");
    try {
      const provider = getBrowserProvider();
      const signer = await provider.getSigner();

      let imageCid = null;
      if (token.image) {
        const imageFile = await urlToFile(token.image, `${token.tokenId}-image`, "image/*");
        const shardedImage = await encryptAndShardFile(imageFile, passkey);
        imageCid = shardedImage.cidAlpha; // Alpha shard's CID is enough to prove + locate the backup; Beta is the other half of the same encrypted pair
      }

      const metadataFile = new File(
        [JSON.stringify({ tokenId: token.tokenId, contractAddress, name: token.name, description: token.description || null, image: token.image || null, tokenURI: token.tokenURI }, null, 2)],
        `${token.tokenId}-metadata.json`,
        { type: "application/json" }
      );
      const shardedMetadata = await encryptAndShardFile(metadataFile, passkey);

      const { address, message, signature, timestamp } = await signNftBackup({
        signer, chainId: BSC_TESTNET_CHAIN_ID, contractAddress, tokenId: token.tokenId,
        imageCid, metadataCid: shardedMetadata.cidAlpha,
      });

      const res = await fetch("/api/nft/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId: BSC_TESTNET_CHAIN_ID, contractAddress, tokenId: token.tokenId, name: token.name, imageCid, metadataCid: shardedMetadata.cidAlpha, address, message, signature, timestamp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Backup failed.");

      setBackedUp((prev) => new Set(prev).add(token.tokenId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBackingUp(null);
    }
  }, [passkey, contractAddress]);

  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-12 md:px-10">
      <div className="max-w-4xl mx-auto">
        <a href="/apps" className="text-[#8a96ab] text-sm hover:text-[#00f2fe] transition-colors">← App Store</a>

        <div className="mt-6 mb-8">
          <span className="text-[11px] font-bold tracking-wider text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 rounded-full px-2 py-0.5">NFT VAULT</span>
          <h1 className="text-3xl font-black text-white tracking-tight mt-3 mb-2">Store &amp; Manage Your NFTs</h1>
          <p className="text-[#94a3b8] text-sm max-w-2xl leading-relaxed">
            Discover the NFTs your wallet owns from a specific collection on BSC Testnet, then back their
            metadata and image up to Inaya&apos;s own encrypted, redundant storage — independent of whatever
            gateway currently hosts them. ERC-721 collections with Enumerable support only for now; a
            non-Enumerable or ERC-1155 collection will say so clearly rather than silently showing nothing.
          </p>
        </div>

        {!account ? (
          <button onClick={connect} className="bg-[#00f2fe] text-[#060913] font-bold text-sm px-5 py-2.5 rounded-lg hover:bg-[#5df9ff] transition-colors">
            Connect Wallet
          </button>
        ) : (
          <div className="space-y-6">
            <p className="text-[#5b6472] text-xs font-mono">Connected: {account}</p>

            <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5 space-y-3">
              <label className="block">
                <span className="text-[#94a3b8] text-xs font-bold uppercase tracking-wide">NFT Contract Address (BSC Testnet)</span>
                <input
                  value={contractAddress}
                  onChange={(e) => setContractAddress(e.target.value)}
                  placeholder="0x..."
                  className="mt-1.5 w-full bg-[#060913] border border-white/10 rounded px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/50"
                />
              </label>
              <button
                onClick={loadNfts}
                disabled={loading || !contractAddress.trim()}
                className="bg-[#00f2fe] text-[#060913] font-bold text-sm px-4 py-2 rounded-lg hover:bg-[#5df9ff] transition-colors disabled:opacity-40"
              >
                {loading ? "Loading…" : "Load My NFTs"}
              </button>
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            {contractInfo && !contractInfo.supported && (
              <p className="text-amber-400 text-sm bg-amber-400/10 border border-amber-400/30 rounded-lg p-3">{contractInfo.reason}</p>
            )}

            {tokens && (
              <>
                <label className="block max-w-sm">
                  <span className="text-[#94a3b8] text-xs font-bold uppercase tracking-wide">Backup Passkey (for encrypting backups)</span>
                  <input
                    type="password"
                    value={passkey}
                    onChange={(e) => setPasskey(e.target.value)}
                    placeholder="Choose a passkey — you'll need it to restore"
                    className="mt-1.5 w-full bg-[#0a0f1e] border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#00f2fe]/50"
                  />
                </label>

                {tokens.length === 0 ? (
                  <p className="text-[#5b6472] text-sm">This wallet doesn&apos;t own any tokens from this collection.</p>
                ) : (
                  <div className="grid sm:grid-cols-3 gap-4">
                    {tokens.map((t) => (
                      <div key={t.tokenId} className="bg-[#0a0f1e] border border-white/10 rounded-xl overflow-hidden flex flex-col">
                        <div className="aspect-square bg-white/5 flex items-center justify-center">
                          {t.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={t.image} alt={t.name} className="w-full h-full object-cover" />
                          ) : (
                            <span className="text-[#5b6472] text-xs">No image</span>
                          )}
                        </div>
                        <div className="p-3 flex flex-col gap-2 flex-1">
                          <p className="text-white text-sm font-bold truncate" title={t.name}>{t.name}</p>
                          <p className="text-[#5b6472] text-[11px] font-mono">Token #{t.tokenId}</p>
                          {t.metadataError && <p className="text-amber-400 text-[11px]">{t.metadataError}</p>}
                          <button
                            onClick={() => backUpToken(t)}
                            disabled={backingUp === t.tokenId || backedUp.has(t.tokenId)}
                            className={`mt-auto text-xs font-bold px-3 py-1.5 rounded-lg transition-colors ${
                              backedUp.has(t.tokenId)
                                ? "bg-emerald-400/10 text-emerald-400 border border-emerald-400/30"
                                : "bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 hover:bg-[#00f2fe]/20 disabled:opacity-40"
                            }`}
                          >
                            {backedUp.has(t.tokenId) ? "✓ Backed Up" : backingUp === t.tokenId ? "Backing up…" : "Back Up to Inaya Storage"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
