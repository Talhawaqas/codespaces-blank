"use client";
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

export default function Home() {
  const [currentPage, setCurrentPage] = useState('Network Home');
  
  // MetaMask Connection Configurations
  const [walletAddress, setWalletAddress] = useState('');
  const [walletBalance, setWalletBalance] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  
  // Storage System Input Configurations
  const [assetId, setAssetId] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [masterPasskey, setMasterPasskey] = useState('');
  const [pinataJwt, setPinataJwt] = useState('');
  const [queryAssetId, setQueryAssetId] = useState('');
  
  // Real-time Console Log Handlers
  const [statusLog, setStatusLog] = useState('');
  const [txHashLink, setTxHashLink] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [restoredName, setRestoredName] = useState('');

  const liveContractAddress = "0x78d84E7ab7aAa1a9d6Bc03A64ADD995cB3f9bAb3";
  
  const contractABI = [
    "function registerAsset(string assetId, string filename, string cidAlpha, string cidBeta) public",
    "function getAsset(string assetId) public view returns (string filename, string cidAlpha, string cidBeta, uint256 timestamp, address operator)"
  ];

  const connectWallet = async () => {
    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        setWalletAddress(accounts[0]);
        setIsConnected(true);
        const balanceHex = await window.ethereum.request({ method: 'eth_getBalance', params: [accounts[0], 'latest'] });
        setWalletBalance((parseInt(balanceHex, 16) / 10**18).toFixed(4));
      } catch (err) { console.error(err); }
    } else { alert("Please install MetaMask extension to interface with the ledger layer!"); }
  };

  // ✨ FIXED: Added explicit typeof to prevent client hydration crashes
  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      window.ethereum.on('accountsChanged', (accs) => {
        if (accs.length > 0) { setWalletAddress(accs[0]); setIsConnected(true); }
        else { setWalletAddress(''); setIsConnected(false); }
      });
    }
  }, []);

  // 🔐 AES Encryption Protocol Module
  const encryptData = async (text, password) => {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const key = await window.crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
    );
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(text));
    
    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    combined.set(salt, 0); combined.set(iv, salt.length); combined.set(new Uint8Array(encrypted), salt.length + iv.length);
    
    let binary = '';
    for (let i = 0; i < combined.byteLength; i++) { binary += String.fromCharCode(combined[i]); }
    return window.btoa(binary);
  };

  // 🔓 AES Decryption Protocol Module
  const decryptData = async (base64Str, password) => {
    const enc = new TextDecoder();
    const binaryStr = window.atob(base64Str);
    const combined = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) { combined[i] = binaryStr.charCodeAt(i); }
    
    const salt = combined.slice(0, 16); const iv = combined.slice(16, 28); const encrypted = combined.slice(28);
    const keyMaterial = await window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await window.crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, encrypted);
    return enc.decode(decrypted);
  };

  const uploadToPinata = async (encryptedShard, filename, elementTag) => {
    const url = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
    const payload = {
      pinataContent: { shard: encryptedShard, element: elementTag },
      pinataMetadata: { name: `inaya_next_${elementTag}_${filename}` }
    };
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${pinataJwt.trim()}` },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`IPFS node rejected transmission sequence.`);
    const data = await response.json();
    return data.IpfsHash;
  };

  const handleUploadSequence = async () => {
    if (!assetId || !selectedFile || !masterPasskey || !pinataJwt) {
      alert("Handshake Error: Ensure Passkey, Pinata JWT, and Asset ID parameters are filled."); return;
    }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog("📡 Reading corporate data object archive into memory blocks...");
      const reader = new FileReader();
      reader.readAsDataURL(selectedFile);
      reader.onload = async () => {
        try {
          const base64RawData = reader.result;
          setStatusLog("🔒 Encrypting files using client-side isolated PBKDF2/AES algorithms...");
          const cipherTextString = await encryptData(base64RawData, masterPasskey);
          
          const midpoint = Math.ceil(cipherTextString.length / 2);
          const chunkAlpha = cipherTextString.slice(0, midpoint);
          const chunkBeta = cipherTextString.slice(midpoint);
          
          setStatusLog("☁️ Shipping Vector Alpha fragment block to Pinata IPFS swarm...");
          const cidA = await uploadToPinata(chunkAlpha, selectedFile.name, "Alpha");
          setStatusLog("☁️ Shipping Vector Beta fragment block to Pinata IPFS swarm...");
          const cidB = await uploadToPinata(chunkBeta, selectedFile.name, "Beta");
          
          setStatusLog("🦊 Connecting network handles. Please approve gas signatures inside MetaMask pop-up...");
          const provider = new ethers.BrowserProvider(window.ethereum);
          const signer = await provider.getSigner();
          const contract = new ethers.Contract(liveContractAddress, contractABI, signer);
          
          const tx = await contract.registerAsset(assetId, selectedFile.name, cidA, cidB);
          setStatusLog("⛓️ Broadcast Success. Syncing state registers across validator nodes...");
          await tx.wait();
          
          setStatusLog("🎯 ON-CHAIN TRANSACTION CONFIRMED! Data asset receipts are permanently immutable.");
          setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
        } catch (innerErr) { setStatusLog(`❌ Pipeline Mismatch Exception: ${innerErr.message}`); }
      };
    } catch (err) { setStatusLog(`❌ Execution Fault: ${err.message}`); }
  };

  const handleRetrievalSequence = async () => {
    if (!queryAssetId || !masterPasskey) { alert("Missing target blockchain indexing maps."); return; }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog("🔍 Accessing EVM ledger storage maps for target CIDs...");
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      
      const record = await contract.getAsset(queryAssetId);
      const [onchainFilename, cidAlpha, cidBeta] = record;
      
      setStatusLog("🌐 Syncing shard locations. Reconstructing shards from IPFS gateways...");
      const fetchShard = async (cid) => {
        const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
        const json = await res.json();
        return json.shard;
      };
      
      const shardA = await fetchShard(cidAlpha);
      const shardB = await fetchShard(cidBeta);
      
      setStatusLog("🔓 Decoding unified byte matrices using localized master node passkey...");
      const fullCipherText = shardA + shardB;
      const decryptedBase64 = await decryptData(fullCipherText, masterPasskey);
      
      setRestoredName(onchainFilename);
      setDownloadUrl(decryptedBase64);
      setStatusLog("💚 SIGNATURE INTEGRITY CHECKS PASSED: Data object is authenticated.");
    } catch (err) { setStatusLog(`⛔ Extraction Exception: Asset index not found or key validation failed. Details: ${err.message}`); }
  };

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans antialiased selection:bg-[#00f2fe]/30">
      
      {/* HEADER NAVBAR */}
      <header className="flex justify-between items-center bg-[#0a0f1e]/80 border-b border-[#00f2fe]/15 px-10 py-5 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] w-3.5 h-3.5 rounded-sm shadow-[0_0_10px_#00f2fe]"></div>
          <span className="text-white font-extrabold text-lg tracking-wider">INAYA NETWORK</span>
        </div>
        <button onClick={connectWallet} className={`px-6 py-2 rounded-full text-xs font-mono font-bold tracking-wider transition-all duration-300 transform active:scale-95 ${isConnected ? 'bg-[#00f2fe]/10 border border-[#00f2fe] text-[#00f2fe] shadow-[0_0_20px_rgba(0,242,254,0.15)]' : 'bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] hover:shadow-[0_0_20px_rgba(0,242,254,0.4)]'}`}>{isConnected ? `🛡️ ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4).toUpperCase()}` : '🔌 CONNECT METAMASK'}</button>
      </header>

      <div className="flex">
        {/* SIDEBAR */}
        <aside className="w-80 border-r border-white/5 bg-[#080c18]/60 p-6 min-h-[calc(100vh-80px)] backdrop-blur-md">
          <div className="mb-6"><div className="text-[#64748b] font-mono text-[10px] font-bold tracking-widest">SECURE HARDWARE</div><div className="text-white text-base font-bold mt-0.5">ADMIN SECURITY DOCK</div></div>
          <hr className="border-white/5 mb-6" />
          <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl font-mono mb-6"><div className="text-[#64748b] text-[10px] uppercase tracking-wider">On-Chain Target Contract:</div><div className="text-[#00f2fe] text-xs break-all mt-1.5 font-bold">{liveContractAddress}</div></div>
          
          <div className="space-y-5">
            <div>
              <label className="block text-xs text-[#94a3b8] font-semibold mb-2">Master Node Passkey:</label>
              <input type="password" value={masterPasskey} onChange={(e) => setMasterPasskey(e.target.value)} placeholder="••••••••" className="w-full bg-[#090d16] border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/50" />
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] font-semibold mb-2">Swarm API Key (JWT):</label>
              <input type="password" value={pinataJwt} onChange={(e) => setPinataJwt(e.target.value)} placeholder="••••••••" className="w-full bg-[#090d16] border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/50" />
            </div>
            <div className="border border-white/5 bg-black/20 p-4 rounded-xl">
              <div className="text-[#64748b] font-mono text-[9px] uppercase tracking-wider">MetaMask Injection Bridge</div>
              {isConnected ? (
                <div className="mt-3 space-y-2">
                  <div className="flex justify-between items-center text-xs"><span className="text-[#94a3b8]">Status:</span><span className="text-emerald-400 font-bold font-mono">CONNECTED</span></div>
                  <div className="flex justify-between items-center text-xs"><span className="text-[#94a3b8]">Gas Balance:</span><span className="text-white font-mono font-bold">{walletBalance} tBNB</span></div>
                </div>
              ) : ( <div className="text-[#64748b] text-xs italic mt-2 font-mono leading-relaxed">// Waiting for connection handshake authorization...</div> )}
            </div>
          </div>
        </aside>

        {/* MAIN PANEL */}
        <main className="flex-1 p-10">
          <nav className="flex bg-[#090d15]/60 border border-white/5 p-1.5 rounded-xl max-w-4xl mx-auto mb-10 gap-2 justify-between backdrop-blur-md">
            {['Network Home', 'Tech Features', 'Sovereign Vault', 'Ecosystem Economy'].map((tab) => (
              <button key={tab} onClick={() => setCurrentPage(tab)} className={`flex-1 text-center py-2.5 text-xs font-semibold rounded-lg tracking-wide transition-all ${currentPage === tab ? 'text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40' : 'text-[#64748b] hover:text-[#00f2fe]'}`}>{tab}</button>
            ))}
          </nav>

          {currentPage === 'Network Home' && (
            <div>
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Sovereign Data Storage Scaling Networks</h2>
              <p className="text-[#94a3b8] text-sm mb-8">Next-generation client-side runtime parameters reskinned onto pure modular Tailwind DOM layouts.</p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "ACTIVE_NODE" : "WAITING_AUTH"}</div><div className="text-[10px] uppercase text-[#64748b] tracking-wildest mt-1">Wallet Core Status</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">30,000,000</div><div className="text-[10px] uppercase text-[#64748b] tracking-wildest mt-1">Verified Supply Cap</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "99.999%" : "0.000%"}</div><div className="text-[10px] uppercase text-[#64748b] tracking-wildest mt-1">EVM Sync Confidence</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">&lt; 0.05s</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">Reactive DOM Latency</div></div>
              </div>
            </div>
          )}

          {currentPage === 'Sovereign Vault' && (
            <div>
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Hardened Cryptographic Storage Core</h2>
              <p className="text-[#94a3b8] text-sm mb-6">Fully integrated client-side PBKDF2/AES data processor with ledger validation triggers.</p>
              
              {/* STATUS MONITOR PANEL */}
              {statusLog && (
                <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl max-w-3xl mb-6 shadow-[0_0_15px_rgba(0,242,254,0.05)]">
                  ⚙️ System Status Console Logs:<br /><span className="text-white text-xs mt-1 block">{statusLog}</span>
                  {txHashLink && <a href={txHashLink} target="_blank" className="text-emerald-400 font-bold block mt-2 underline">🔗 VIEW TRANSACTION ON BSCSCAN EXPLORER</a>}
                  {downloadUrl && <a href={downloadUrl} download={restoredName} className="inline-block mt-3 bg-gradient-to-r from-emerald-500 to-teal-600 text-slate-900 font-bold text-xs font-sans px-5 py-2.5 rounded-lg shadow-lg hover:brightness-110">📥 DOWNLOAD DECRYPTED RESTORED ASSET OBJECT</a>}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl">
                {/* UPLOAD WORKSPACE */}
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl">
                  <h3 className="text-base font-bold text-white mb-4">📥 Input Secure Shard Broadcast Pipeline</h3>
                  <div className="space-y-4">
                    <div><label className="block text-xs text-[#94a3b8] mb-1">Target Tracking Asset ID:</label><input type="text" value={assetId} onChange={(e) => setAssetId(e.target.value)} placeholder="e.g. 99" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm" /></div>
                    <div><label className="block text-xs text-[#94a3b8] mb-1">Select File Stream:</label><input type="file" onChange={(e) => setSelectedFile(e.target.files[0])} className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2 text-white text-xs py-2.5" /></div>
                    {isConnected ? (
                      <button onClick={handleUploadSequence} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-[#060913] bg-gradient-to-r from-[#00f2fe] to-[#4facfe] hover:shadow-[0_0_20px_rgba(0,242,254,0.3)] transition-all">SIGN & EMIT SECURE RECORD</button>
                    ) : ( <button onClick={connectWallet} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-amber-500 bg-amber-500/5 border border-amber-500/20">⚠️ HANDSHAKE TO CONNECT WALLET FIRST</button> )}
                  </div>
                </div>

                {/* RETRIEVAL WORKSPACE */}
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl">
                  <h3 className="text-base font-bold text-white mb-4">🔓 On-Chain Ledger Extraction Assembly</h3>
                  <div className="space-y-4">
                    <div><label className="block text-xs text-[#94a3b8] mb-1">Query Asset ID from Ledger:</label><input type="text" value={queryAssetId} onChange={(e) => setQueryAssetId(e.target.value)} placeholder="e.g. 99" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm" /></div>
                    <div className="pt-7">
                      {isConnected ? (
                        <button onClick={handleRetrievalSequence} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-[#060913] bg-gradient-to-r from-[#00f2fe] to-[#4facfe] hover:shadow-[0_0_20px_rgba(0,242,254,0.3)] transition-all">COMPILE AND RECONSTRUCT FRAGMENTS</button>
                      ) : ( <button onClick={connectWallet} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-amber-500 bg-amber-500/5 border border-amber-500/20">⚠️ HANDSHAKE TO CONNECT WALLET FIRST</button> )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {['Tech Features', 'Ecosystem Economy'].includes(currentPage) && (
            <div className="py-20 text-center">
              <div className="text-[#64748b] font-mono text-xs uppercase tracking-widest mb-1">// View Node Parameters Active</div>
              <h3 className="text-white font-bold text-base">Layout Compile Checked</h3>
              <p className="text-[#94a3b8] text-xs max-w-md mx-auto mt-2">Tailwind assets compiled cleanly onto standard structural nodes.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}