"use client";

// app/business/share/[token]/page.js
//
// The public landing page for a secure share link
// (https://.../business/share/XXXXXXXX). Deliberately NOT behind the
// /business auth wall — this is the one page in the whole org/document
// system meant to work for someone with no account at all, matching the
// backend's GET /api/orgs/share/[token] (the only unauthenticated route).
//
// The passkey prompt exists because this system's documents are client-
// side encrypted with a passkey the server never sees or stores (same as
// every other document here) — a share link proves you're allowed to
// FETCH the encrypted content, not that you know how to decrypt it. The
// document owner needs to give the recipient the passkey separately.

import { useState, useEffect } from "react";

async function decryptData(base64Str, password) {
  const binaryStr = window.atob(base64Str);
  const combined = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) combined[i] = binaryStr.charCodeAt(i);
  const salt = combined.slice(0, 16);
  const iv = combined.slice(16, 28);
  const encrypted = combined.slice(28);
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

async function fetchShardFromIPFS(cid) {
  try {
    const res = await fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`);
    const json = await res.json();
    return json.shard;
  } catch {
    const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
    const json = await res.json();
    return json.shard;
  }
}

export default function SharePage({ params }) {
  const { token } = params;
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [passkey, setPasskey] = useState("");
  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState("");

  useEffect(() => {
    fetch(`/api/orgs/share/${token}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "This link is invalid.");
        setInfo(data);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleDecrypt(e) {
    e.preventDefault();
    if (!passkey) return;
    setDecrypting(true);
    setDecryptError("");
    try {
      const [shardA, shardB] = await Promise.all([fetchShardFromIPFS(info.cidAlpha), fetchShardFromIPFS(info.cidBeta)]);
      const dataUrl = await decryptData(shardA + shardB, passkey);
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = info.filename;
      a.click();
    } catch {
      setDecryptError("Could not decrypt this document — check the passkey and try again.");
    } finally {
      setDecrypting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
      <div className="max-w-sm w-full">
        <h1 className="text-lg font-extrabold text-white text-center mb-1">INAYA <span className="text-[#00f2fe]">NETWORK</span></h1>
        <p className="text-[#8a96ab] text-xs text-center mb-8">Shared document</p>

        {loading ? (
          <p className="text-[#8a96ab] text-sm text-center">Loading…</p>
        ) : error ? (
          <div className="bg-red-400/10 border border-red-400/20 rounded-2xl p-6 text-center">
            <p className="text-red-400 text-sm">{error}</p>
            <p className="text-[#8a96ab] text-xs mt-2">Ask whoever shared this with you for a new link.</p>
          </div>
        ) : (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <p className="text-xs text-[#8a96ab] uppercase tracking-wider mb-1">Document</p>
            <p className="text-white text-sm mb-1 truncate">{info.filename}</p>
            <p className="text-[#8a96ab] text-xs mb-5">{(info.sizeBytes / 1024).toFixed(1)} KB</p>

            <form onSubmit={handleDecrypt} className="space-y-2">
              <input
                type="password"
                value={passkey}
                onChange={(e) => setPasskey(e.target.value)}
                placeholder="Encryption passkey"
                className="w-full bg-black/30 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#8a96ab]"
              />
              <button disabled={decrypting || !passkey} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
                {decrypting ? "Decrypting…" : "Decrypt & download"}
              </button>
            </form>
            {decryptError && <p className="text-red-400 text-xs mt-3">{decryptError}</p>}
            <p className="text-[#8a96ab] text-[12px] mt-4 text-center">Don't have the passkey? Ask whoever shared this document with you.</p>
          </div>
        )}
      </div>
    </div>
  );
}
