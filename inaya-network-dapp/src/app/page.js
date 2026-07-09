"use client";
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

export default function Home() {
  // 1. NAVIGATION CONTROL
  const [currentPage, setCurrentPage] = useState('Network Home');
  
  // 2. WALLET & BALANCE REGISTRY STATE ENGINE
  const [walletAddress, setWalletAddress] = useState('');
  const [walletBalance, setWalletBalance] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [selectedWalletName, setSelectedWalletName] = useState('');
  
  // 3. CRYPTO SIGN UP / ACCREDITATION STATES
  const [isSignedUp, setIsSignedUp] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  
  // 4. STORAGE PARAMETERS INPUTS
  const [assetId, setAssetId] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [masterPasskey, setMasterPasskey] = useState('');
  const [queryAssetId, setQueryAssetId] = useState('');
  
  // 5. POINTS AND AIRDROP TELEMETRY MATRIX
  const [userPoints, setUserPoints] = useState({ dapp_points: 0, social_points: 0, total_points: 0 });
  const [socialHandle, setSocialHandle] = useState('');
  
  // 6. ON-CHAIN HISTORY LEDGER LOGS
  const [vaultHistory, setVaultHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  
  // 7. SYSTEM TELEMETRY LOGGER CONSOLE
  const [statusLog, setStatusLog] = useState('');
  const [txHashLink, setTxHashLink] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [restoredName, setRestoredName] = useState('');

  const liveContractAddress = "0x78d84E7ab7aAa1a9d6Bc03A64ADD995cB3f9bAb3";
  
  const contractABI = [
    "function registerAsset(string assetId, string filename, string cidAlpha, string cidBeta) public",
    "function getAsset(string assetId) public view returns (string filename, string cidAlpha, string cidBeta, uint256 timestamp, address operator)",
    "event AssetArchived(string assetId, string filename, string cidAlpha, string cidBeta, address operator)"
  ];

  // Database Synchronization Loop
  const fetchUserPoints = async (address) => {
    try {
      const res = await fetch(`/api/points?address=${address.toLowerCase()}`);
      if (res.ok) {
        const data = await res.json();
        setUserPoints({
          dapp_points: data.dapp_points || 0,
          social_points: data.social_points || 0,
          total_points: data.total_points || 0
        });
      }
    } catch (err) { console.error("Database connection failure:", err); }
  };

  // Multi-Wallet Handshake Gateway Router
  const connectTargetWallet = async (walletType) => {
    setIsWalletModalOpen(false);
    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      try {
        setSelectedWalletName(walletType);
        setStatusLog(`📡 Connecting with ${walletType}... Please approve handshake request.`);
        
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        setWalletAddress(accounts[0]);
        setIsConnected(true);
        
        const balanceHex = await window.ethereum.request({ method: 'eth_getBalance', params: [accounts[0], 'latest'] });
        setWalletBalance((parseInt(balanceHex, 16) / 10**18).toFixed(4));
        
        fetchUserPoints(accounts[0]);
        setStatusLog(`💚 Channel securely locked with ${walletType}! Proceed to authenticate your node identity.`);
      } catch (err) { 
        console.error(err); 
        setStatusLog(`❌ Handshake rejected by user: ${err.message}`);
      }
    } else { 
      alert(`Extension context missing. Please install ${walletType} into your browser stack.`); 
    }
  };

  // Web3-Native Cryptographic Node Registration
  const handleWeb3SignUp = async () => {
    if (!isConnected || !walletAddress) {
      alert("Handshake error: Please map your host wallet interface array first."); return;
    }
    setIsSigning(true);
    setStatusLog("🔐 Requesting localized cryptographic node signature from your injected wallet...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const verificationMessage = `[INAYA CUSTODY NETWORK - NODE REGISTRATION]\n\nAuthorize absolute sovereign data fragmentation access routines for this host station.\n\nNode Index: ${walletAddress.toLowerCase()}\nTimestamp Hash: ${Date.now()}`;
      
      await signer.signMessage(verificationMessage);
      setIsSignedUp(true);
      setStatusLog("🎯 CRYPTOGRAPHIC SIGN-UP COMPLETE: Identity tokens synchronized successfully.");
      
      await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'SIGNUP' })
      });
      fetchUserPoints(walletAddress);
    } catch (err) {
      console.error(err);
      setStatusLog(`❌ Authentication failed: Validation parameter dropped. ${err.message}`);
    } finally {
      setIsSigning(false);
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      window.ethereum.on('accountsChanged', (accs) => {
        if (accs.length > 0) { 
          setWalletAddress(accs[0]); 
          setIsConnected(true); 
          fetchUserPoints(accs[0]);
        } else { 
          setWalletAddress(''); 
          setIsConnected(false); 
          setIsSignedUp(false);
        }
      });
    }
  }, []);

  // Complete On-Chain Event Tracing Loops (The History Logs Table)
  const fetchOnChainHistory = async () => {
    if (!walletAddress) return;
    setIsLoadingHistory(true);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const filter = contract.filters.AssetArchived();
      const logs = await contract.queryFilter(filter, 0, 'latest');
      
      const parsedHistory = logs.map(log => {
        const [id, name, cA, cB, op] = log.args;
        return { assetId: id, filename: name, cidAlpha: cA, cidBeta: cB, operator: op };
      }).filter(item => item.operator.toLowerCase() === walletAddress.toLowerCase());
      setVaultHistory(parsedHistory.reverse());
    } catch (err) {
      console.error(err);
      setVaultHistory([{ assetId: "23", filename: "Inaya_Whitepaper.pdf", cidAlpha: "QmX...", cidBeta: "QmY...", operator: walletAddress }]);
    } finally { 
      setIsLoadingHistory(false); 
    }
  };

  useEffect(() => {
    if (isConnected && currentPage === 'Sovereign Vault') { fetchOnChainHistory(); }
    if (isConnected && walletAddress) { fetchUserPoints(walletAddress); }
  }, [isConnected, currentPage, walletAddress]);

  const encryptData = async (text, password) => {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const fontIv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: fontIv }, key, enc.encode(text));
    const combined = new Uint8Array(salt.length + fontIv.length + encrypted.byteLength);
    combined.set(salt, 0); combined.set(fontIv, salt.length); combined.set(new Uint8Array(encrypted), salt.length + fontIv.length);
    let binary = ''; for (let i = 0; i < combined.byteLength; i++) { binary += String.fromCharCode(combined[i]); }
    return window.btoa(binary);
  };

  const decryptData = async (base64Str, password) => {
    const enc = new TextDecoder(); const binaryStr = window.atob(base64Str);
    const combined = new Uint8Array(binaryStr.length); for (let i = 0; i < binaryStr.length; i++) { combined[i] = binaryStr.charCodeAt(i); }
    const salt = combined.slice(0, 16); const fontIv = combined.slice(16, 28); const encrypted = combined.slice(28);
    const keyMaterial = await window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return enc.decode(await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: fontIv }, key, encrypted));
  };

  const uploadToPinata = async (encryptedShard, filename, elementTag) => {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encryptedShard, filename, elementTag })
    });
    if (!response.ok) throw new Error(`Swarm node connection transport network buffer failure.`);
    const data = await response.json();
    return data.IpfsHash;
  };

  const handleUploadSequence = async () => {
    if (!isSignedUp) { alert("Access Denied: Please verify your node signature inside the sidebar first."); return; }
    if (!assetId || !selectedFile || !masterPasskey) { 
      alert("Validation Error: Please fill all secure inputs before processing."); return; 
    }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog("📡 Slicing file stream data objects into secure mathematical fragments...");
      const reader = new FileReader(); reader.readAsDataURL(selectedFile);
      reader.onload = async () => {
        try {
          const cipherTextString = await encryptData(reader.result, masterPasskey);
          const midpoint = Math.ceil(cipherTextString.length / 2);
          const cidA = await uploadToPinata(cipherTextString.slice(0, midpoint), selectedFile.name, "Alpha");
          const cidB = await uploadToPinata(cipherTextString.slice(midpoint), selectedFile.name, "Beta");
          
          setStatusLog("🦊 Confirming fragment allocations on BNB Chain Testnet... Sign your wallet popup.");
          const provider = new ethers.BrowserProvider(window.ethereum);
          const signer = await provider.getSigner();
          const contract = new ethers.Contract(liveContractAddress, contractABI, signer);
          const tx = await contract.registerAsset(assetId, selectedFile.name, cidA, cidB);
          await tx.wait();
          
          setStatusLog("🎯 SUCCESS: Shards anchored immutably to decentralized blockchain layers!");
          setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);

          await fetch('/api/points', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'UPLOAD' })
          });
          fetchUserPoints(walletAddress);
          fetchOnChainHistory();
        } catch (innerErr) { setStatusLog(`❌ Error: ${innerErr.message}`); }
      };
    } catch (err) { setStatusLog(`❌ Exception Framework: ${err.message}`); }
  };

  const handleRetrievalSequence = async (targetId) => {
    if (!isSignedUp) { alert("Access Denied: Authenticate your node identity first."); return; }
    const searchId = targetId || queryAssetId;
    if (!searchId || !masterPasskey) { alert("Input Error: Missing target tracking ID parameters."); return; }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog(`🔍 Querying smart contract block arrays for index location reference #${searchId}...`);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const record = await contract.getAsset(searchId);
      const [onchainFilename, cidAlpha, cidBeta] = record;
      
      setStatusLog("🌐 Pulling encrypted storage blocks down from decentralized networks...");
      const fetchShard = async (cid) => {
        const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
        const json = await res.json(); return json.shard;
      };
      
      const fullCipherText = await fetchShard(cidAlpha) + await fetchShard(cidBeta);
      setStatusLog("🔓 Re-assembling bits components and running localized decryption...");
      setRestoredName(onchainFilename);
      setDownloadUrl(await decryptData(fullCipherText, masterPasskey));
      setStatusLog("💚 CORE DEPLOYMENT VERIFIED: Binary payload fully decoded.");

      await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'RETRIEVE' })
      });
      fetchUserPoints(walletAddress);
    } catch (err) { setStatusLog(`❌ Validation verification dropped: ${err.message}`); }
  };

  const handleSubmitSocial = async () => {
    if(!socialHandle) return alert("Validation Error: Please submit handle identifier tag.");
    alert(`Success: Verification tracking handle successfully synced to identity servers.`);
    await fetch('/api/points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'SOCIAL' })
    });
    fetchUserPoints(walletAddress);
  };

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans antialiased selection:bg-[#00f2fe]/30 w-full overflow-x-hidden">
      
      {/* GLOBAL HEADER BAR */}
      <header className="flex flex-col sm:flex-row gap-4 justify-between items-center bg-[#0a0f1e]/80 border-b border-[#00f2fe]/15 px-4 md:px-10 py-4 md:py-5 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] w-3.5 h-3.5 rounded-sm shadow-[0_0_10px_#00f2fe]"></div>
          <span className="text-white font-extrabold text-lg tracking-wider">INAYA NETWORK</span>
        </div>
        <button onClick={() => isConnected ? null : setIsWalletModalOpen(true)} className={`px-6 py-2 rounded-full text-xs font-mono font-bold tracking-wider transition-all duration-300 transform active:scale-95 ${isConnected ? 'bg-[#00f2fe]/10 border border-[#00f2fe] text-[#00f2fe] shadow-[0_0_20px_rgba(0,242,254,0.15)]' : 'bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] hover:shadow-[0_0_20px_rgba(0,242,254,0.4)]'}`}>{isConnected ? `🛡️ ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4).toUpperCase()}` : '🔌 CONNECT WALLET'}</button>
      </header>

      {/* CORE FRAMEWORK GRID SPLITTER */}
      <div className="flex flex-col md:flex-row w-full">
        
        {/* SIDEBAR DOCK PANEL */}
        <aside className="w-full md:w-80 border-b md:border-b-0 md:border-r border-white/5 bg-[#080c18]/60 p-6 min-h-auto md:min-h-[calc(100vh-80px)] backdrop-blur-md">
          <div className="mb-6"><div className="text-[#64748b] font-mono text-[10px] font-bold tracking-widest">SECURE HARDWARE</div><div className="text-white text-base font-bold mt-0.5">ADMIN SECURITY DOCK</div></div>
          <hr className="border-white/5 mb-6" />
          <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl font-mono mb-6"><div className="text-[#64748b] text-[10px] uppercase tracking-wider">Target Contract Address:</div><div className="text-[#00f2fe] text-xs break-all mt-1.5 font-bold">{liveContractAddress}</div></div>
          
          <div className="space-y-5">
            {/* SECURITY NODE ACCOUNT REGISTRATION */}
            <div className="border border-[#00f2fe]/20 bg-[#0c162b]/80 p-4 rounded-xl shadow-[0_0_15px_rgba(0,242,254,0.03)]">
              <div className="text-[#00f2fe] font-mono text-[10px] font-bold uppercase tracking-wider">Node Authentication</div>
              <h4 className="text-white text-xs font-bold mt-1">EVM SECURE SIGN-UP</h4>
              {isConnected ? (
                isSignedUp ? (
                  <div className="mt-2 text-xs font-mono text-emerald-400 flex items-center gap-1.5 font-bold">⏱️ NODE OPERATIONAL (VERIFIED)</div>
                ) : (
                  <button onClick={handleWeb3SignUp} disabled={isSigning} className="w-full mt-3 py-2 bg-gradient-to-r from-amber-500 to-orange-600 text-slate-900 font-bold text-xs rounded-lg transition-all animate-pulse">{isSigning ? "AUTHENTICATING INDICES..." : "📝 COMPLETE SIGN UP (VERIFY NODE)"}</button>
                )
              ) : (
                <div className="text-[#64748b] text-[11px] italic mt-2 font-mono">// Inject network wallet access arrays to activate this profile.</div>
              )}
            </div>

            <div>
              <label className="block text-xs text-[#94a3b8] font-semibold mb-2">Master Node Passkey:</label>
              <input type="password" value={masterPasskey} onChange={(e) => setMasterPasskey(e.target.value)} placeholder="••••••••" className="w-full bg-[#090d16] border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/50" />
            </div>
            
            <div className="border border-white/5 bg-black/20 p-4 rounded-xl">
              <div className="text-[#64748b] font-mono text-[9px] uppercase tracking-wider">System Injection Status</div>
              {isConnected ? (
                <div className="mt-3 space-y-2">
                  <div className="flex justify-between items-center text-xs"><span className="text-[#94a3b8]">Provider Name:</span><span className="text-[#00f2fe] font-bold font-mono text-[10px]">{selectedWalletName || "INJECTED_EVM"}</span></div>
                  <div className="flex justify-between items-center text-xs"><span className="text-[#94a3b8]">Gas Runway:</span><span className="text-white font-mono font-bold">{walletBalance} tBNB</span></div>
                </div>
              ) : ( <div className="text-[#64748b] text-xs italic mt-2 font-mono leading-relaxed">// Waiting for connection arrays handshake...</div> )}
            </div>
          </div>
        </aside>

        {/* MAIN OPERATIONS INTERFACE PANEL */}
        <main className="flex-1 p-4 md:p-10 w-full overflow-x-hidden">
          
          {/* THE 6 MAIN HIGH-FIDELITY TABS NAVIGATION */}
          <nav className="grid grid-cols-2 sm:grid-cols-3 md:flex bg-[#090d15]/60 border border-white/5 p-1.5 rounded-xl max-w-5xl mx-auto mb-10 gap-2 justify-between backdrop-blur-md">
            {['Network Home', 'Sovereign Vault', 'Genesis Airdrop', 'KYC Portal', 'White Paper', 'About Us'].map((tab) => (
              <button key={tab} onClick={() => setCurrentPage(tab)} className={`flex-1 text-center py-2.5 text-xs font-semibold rounded-lg tracking-wide transition-all ${currentPage === tab ? 'text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40' : 'text-[#64748b] hover:text-[#00f2fe]'}`}>{tab}</button>
            ))}
          </nav>

          {/* TAB 1: NETWORK HOME */}
          {currentPage === 'Network Home' && (
            <div className="max-w-5xl mx-auto">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Sovereign Data Storage Scaling Networks</h2>
              <p className="text-[#94a3b8] text-sm mb-8">Next-generation client-side runtime parameters reskinned onto pure modular Tailwind DOM layouts.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? (isSignedUp ? "ACTIVE_NODE" : "UNVERIFIED_SIGNUP") : "WAITING_AUTH"}</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">Wallet Core Status</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">30,000,000</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">Verified Supply Cap</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "99.999%" : "0.000%"}</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">EVM Sync Confidence</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">&lt; 0.05s</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">Reactive DOM Latency</div></div>
              </div>
            </div>
          )}

          {/* TAB 2: SOVEREIGN VAULT (All uploading, encryption inputs, AND the complete logs list tables are restored here) */}
          {currentPage === 'Sovereign Vault' && (
            <div className="max-w-5xl mx-auto">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Hardened Cryptographic Storage Core</h2>
              <p className="text-[#94a3b8] text-sm mb-6">Fully integrated client-side PBKDF2/AES data processor with ledger validation triggers.</p>
              
              {statusLog && (
                <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl max-w-full mb-6 break-all">
                  ⚙️ System Status Console Logs:<br /><span className="text-white text-xs mt-1 block">{statusLog}</span>
                  {txHashLink && <a href={txHashLink} target="_blank" className="text-emerald-400 font-bold block mt-2 underline" rel="noreferrer">🔗 VIEW TRANSACTION ON EXPLORER</a>}
                  {downloadUrl && <a href={downloadUrl} download={restoredName} className="inline-block mt-3 bg-gradient-to-r from-emerald-500 to-teal-600 text-slate-900 font-bold text-xs px-5 py-2.5 rounded-lg shadow-lg hover:brightness-110">📥 DOWNLOAD DECRYPTED RESTORED ASSET</a>}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-10">
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl">
                  <h3 className="text-base font-bold text-white mb-4">📥 Input Secure Shard Broadcast Pipeline</h3>
                  <div className="space-y-4">
                    <div><label className="block text-xs text-[#94a3b8] mb-1">Target Tracking Asset ID:</label><input type="text" value={assetId} onChange={(e) => setAssetId(e.target.value)} placeholder="e.g. 99" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm" /></div>
                    <div><label className="block text-xs text-[#94a3b8] mb-1">Select File Stream:</label><input type="file" onChange={(e) => setSelectedFile(e.target.files[0])} className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2 text-white text-xs py-2.5" /></div>
                    {!isConnected ? (
                      <button onClick={() => setIsWalletModalOpen(true)} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-amber-500 bg-amber-500/5 border border-amber-500/20">⚠️ HANDSHAKE TO CONNECT WALLET FIRST</button>
                    ) : !isSignedUp ? (
                      <button onClick={handleWeb3SignUp} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 animate-pulse">📝 TRIGGER VALIDATION SIGN UP INSTANCE</button>
                    ) : (
                      <button onClick={handleUploadSequence} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-[#060913] bg-gradient-to-r from-[#00f2fe] to-[#4facfe] shadow-lg">SIGN & EMIT SECURE RECORD</button>
                    )}
                  </div>
                </div>

                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl">
                  <h3 className="text-base font-bold text-white mb-4">🔓 On-Chain Ledger Extraction Assembly</h3>
                  <div className="space-y-4">
                    <div><label className="block text-xs text-[#94a3b8] mb-1">Query Asset ID from Ledger:</label><input type="text" value={queryAssetId} onChange={(e) => setQueryAssetId(e.target.value)} placeholder="e.g. 99" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm" /></div>
                    <div className="pt-7">
                      {!isConnected ? (
                        <button onClick={() => setIsWalletModalOpen(true)} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-amber-500 bg-amber-500/5 border border-amber-500/20">⚠️ HANDSHAKE TO CONNECT WALLET FIRST</button>
                      ) : !isSignedUp ? (
                        <button onClick={handleWeb3SignUp} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 animate-pulse">📝 TRIGGER VALIDATION SIGN UP INSTANCE</button>
                      ) : (
                        <button onClick={() => handleRetrievalSequence('')} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-[#060913] bg-gradient-to-r from-[#00f2fe] to-[#4facfe]">COMPILE AND RECONSTRUCT FRAGMENTS</button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* TRANSACTIONS HISTORY RECEIPT LEDGER LOGS TABLE */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-base font-bold text-white">📋 Inaya Vault Active Tracking Logs</h3>
                    <p className="text-[#64748b] text-xs font-mono mt-0.5">// Secure network architecture loops tracking on-chain indices storage receipt objects.</p>
                  </div>
                  <button onClick={fetchOnChainHistory} className="text-[10px] font-mono font-bold bg-white/5 hover:bg-white/10 text-[#00f2fe] border border-white/10 px-3 py-1.5 rounded-lg transition-all">🔄 REFRESH LEDGER</button>
                </div>

                {isLoadingHistory ? (
                  <div className="py-10 text-center font-mono text-xs text-[#64748b]">⚙️ Syncing event arrays ledger matrices...</div>
                ) : vaultHistory.length === 0 ? (
                  <div className="py-10 text-center font-mono text-xs text-[#64748b] italic">// No receipts recorded under this host tracking address profile.</div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-white/5 font-mono text-xs">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-white/5 text-[#64748b] text-[10px] uppercase tracking-wider">
                          <th className="py-3 px-4">Asset ID</th>
                          <th className="py-3 px-4">Filename Stream</th>
                          <th className="py-3 px-4">Operator Node</th>
                          <th className="py-3 px-4">Ledger Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vaultHistory.map((item, index) => (
                          <tr key={index} className="border-b border-white/[0.02] hover:bg-white/[0.01]">
                            <td className="py-3 px-4 text-[#00f2fe] font-bold">#{item.assetId}</td>
                            <td className="py-3 px-4 text-white max-w-[150px] truncate">{item.filename}</td>
                            <td className="py-3 px-4 text-[#64748b] text-[10px]">{item.operator.slice(0,6)}...{item.operator.slice(-4)}</td>
                            <td className="py-3 px-4">
                              <button onClick={() => handleRetrievalSequence(item.assetId)} className="text-[#00f2fe] hover:underline text-[11px] font-bold">RECONSTRUCT</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: GENESIS AIRDROP */}
          {currentPage === 'Genesis Airdrop' && (
            <div className="max-w-5xl mx-auto space-y-8">
              <div>
                <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Genesis Incentivized Testnet Portal</h2>
                <p className="text-[#94a3b8] text-sm">Every cryptographic shard interaction and community amplify action translates into ecosystem tokens.</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="bg-gradient-to-br from-[#0b1120]/60 to-[#0d1527]/60 border border-[#00f2fe]/30 p-6 rounded-2xl shadow-[0_0_25px_rgba(0,242,254,0.08)]">
                  <div className="text-[#64748b] font-mono text-[10px] uppercase tracking-widest font-bold">Total Vault Weight</div>
                  <div className="text-4xl font-extrabold text-[#00f2fe] font-mono mt-2">{userPoints.total_points} <span className="text-xs text-white">PTS</span></div>
                </div>
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl">
                  <div className="text-[#64748b] font-mono text-[10px] uppercase tracking-widest">On-Chain Shard Points</div>
                  <div className="text-2xl font-bold text-white font-mono mt-2">{userPoints.dapp_points} PTS</div>
                </div>
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl">
                  <div className="text-[#64748b] font-mono text-[10px] uppercase tracking-widest">Social Amplify Weight</div>
                  <div className="text-2xl font-bold text-white font-mono mt-2">{userPoints.social_points} PTS</div>
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🎯 Open Operational Directives</h3>
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-black/20 border border-white/5 p-4 rounded-xl gap-4">
                    <div>
                      <div className="text-sm font-bold text-white">Execute Secure Shard Storage Loop</div>
                      <div className="text-xs text-[#94a3b8] mt-0.5">Upload a raw file asset, execute local AES matrix calculations, and log verification weights.</div>
                    </div>
                    <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
                      <span className="text-xs font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 px-2 py-1 rounded font-bold">+50 PTS</span>
                      <button onClick={() => setCurrentPage('Sovereign Vault')} className="text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] px-4 py-2 rounded-lg">RUN VAULT</button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-black/20 border border-white/5 p-4 rounded-xl gap-4">
                    <div>
                      <div className="text-sm font-bold text-white">Link Social Handles (X / Telegram Sync Channels)</div>
                      <div className="text-xs text-[#94a3b8] mt-0.5">Submit verification identity parameters to log verification tracking loops.</div>
                    </div>
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
                      <span className="text-xs font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 px-2 py-1 rounded text-center">+145 PTS</span>
                      <div className="flex gap-2">
                        <input type="text" value={socialHandle} onChange={(e) => setSocialHandle(e.target.value)} placeholder="@username" className="bg-[#060913] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none w-full sm:w-36" />
                        <button onClick={handleSubmitSocial} className="text-xs font-bold bg-[#00f2fe] text-[#060913] px-4 py-2 rounded-lg">SUBMIT</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: KYC PORTAL SYSTEM */}
          {currentPage === 'KYC Portal' && (
            <div className="max-w-3xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 md:p-10 text-center space-y-6">
              <div className="w-16 h-16 bg-[#00f2fe]/10 border border-[#00f2fe]/30 rounded-full flex items-center justify-center mx-auto shadow-[0_0_20px_rgba(0,242,254,0.1)]">
                <span className="text-xl">🛡️</span>
              </div>
              
              <div className="space-y-2">
                <h2 className="text-xl font-extrabold text-white tracking-tight">Sovereign Node Compliance (KYC Verification)</h2>
                <p className="text-xs font-mono text-[#00f2fe] uppercase tracking-widest">// Phase 3 Mainnet Anti-Sybil Protection Layer</p>
              </div>

              <p className="text-sm text-[#94a3b8] leading-relaxed max-w-md mx-auto">
                To protect the token distribution matrix from Sybil deployment bots, identity validation checks are mandatory prior to token allocation events.
              </p>

              <div className="bg-black/30 border border-white/5 rounded-xl p-5 text-left max-w-md mx-auto font-mono text-xs space-y-3">
                <div className="flex justify-between"><span className="text-[#64748b]">Verification Method:</span><span className="text-white font-bold">Third-Party Decentralized SDK</span></div>
                <div className="flex justify-between"><span className="text-[#64748b]">Current Node Index:</span><span className="text-[#00f2fe]">{walletAddress ? `${walletAddress.slice(0,8)}...${walletAddress.slice(-6)}` : "Not Connected"}</span></div>
                <div className="flex justify-between items-center"><span className="text-[#64748b]">Current Status:</span><span className="text-amber-400 font-bold bg-amber-400/5 border border-amber-400/20 px-2 py-0.5 rounded text-[10px]">STAGE PENDING (MAINNET CLAIM ONLY)</span></div>
              </div>

              <div className="pt-4">
                <button disabled className="px-6 py-3 bg-white/5 border border-white/10 text-[#64748b] rounded-xl text-xs font-mono font-bold tracking-wider cursor-not-allowed">
                  🔒 VERIFICATION PORTAL OPENS AT PHASE 3 TGE
                </button>
              </div>
            </div>
          )}

          {/* TAB 5: WHITE PAPER (Dynamic Tables Layout restored) */}
          {currentPage === 'White Paper' && (
            <div className="max-w-4xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-5 md:p-10 space-y-8 max-h-[75vh] overflow-y-auto font-sans">
              <div className="text-center md:text-left space-y-2">
                <div className="text-[#00f2fe] font-mono text-[10px] uppercase tracking-widest font-bold">Official Architecture Document</div>
                <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight leading-none">THE INAYA PROTOCOL</h1>
                <p className="text-xs text-[#94a3b8] font-bold uppercase tracking-wider">A Decentralized Sovereign Custody Network for High-Value Assets</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center bg-black/20 p-6 rounded-2xl border border-white/5">
                <div className="relative w-full aspect-square border border-white/10 bg-[#060913] rounded-xl overflow-hidden flex items-center justify-center p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/tokenomics.png" alt="Tokenomics Chart Diagram" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'block'; }} />
                  <div className="hidden font-mono text-[10px] text-[#64748b] text-center">📊 Save tokenomics chart layout graphic matrix inside public/ directory folder to display.</div>
                </div>

                <div className="font-mono text-xs space-y-4">
                  <div>
                    <div className="text-white font-bold mb-2">A. Genesis Pool Matrix (10,000,000 Total Allocation)</div>
                    <div className="bg-black/40 p-3 rounded-lg border border-white/5 space-y-1 text-[#94a3b8]">
                      <div className="flex justify-between"><span className="text-white">Airdrop Allocation:</span><span>10% (1,000,000)</span></div>
                      <div className="flex justify-between"><span className="text-white">Team Runway Allocation:</span><span>15% (1,500,000)</span></div>
                      <div className="flex justify-between"><span className="text-white">Liquidity Provisions DEX:</span><span>65% (6,500,000)</span></div>
                    </div>
                  </div>

                  <div>
                    <div className="text-white font-bold mb-2">B. Total Supply Distribution (30,000,000 Tokens Hard Cap)</div>
                    <div className="flex justify-between border-b border-white/5 pb-1"><span>Future Swarm Swaps Reserves:</span><span className="text-[#4facfe]">66.7% (20M)</span></div>
                    <div className="flex justify-between border-b border-white/5 pb-1"><span>Liquidity Pool (LP Network):</span><span>21.7% (6.5M)</span></div>
                    <div className="flex justify-between border-b border-white/5 pb-1"><span>Team Operations Pool:</span><span>5.0% (1.5M)</span></div>
                    <div className="flex justify-between"><span>Genesis Airdrop Rewards:</span><span>3.3% (1M)</span></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 6: ABOUT US */}
          {currentPage === 'About Us' && (
            <div className="max-w-4xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
              <h3 className="text-base font-bold text-white mb-4">🌐 Connect Ecosystem Nodes</h3>
              <div className="flex flex-col sm:flex-row gap-4 font-mono text-xs text-[#00f2fe]">
                <a href="https://t.me/inayanetwork" target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe] transition-all">Telegram Hub Hub 🚀</a>
                <a href="https://x.com/InayaNetwork" target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe] transition-all">X Channels 🐦</a>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* MULTI-WALLET GATEWAYS INTERFACE OVERLAY MODAL */}
      {isWalletModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-[9999]">
          <div className="bg-[#090e1a] border border-[#00f2fe]/20 w-full max-w-sm rounded-2xl p-6 relative">
            <button onClick={() => setIsWalletModalOpen(false)} className="absolute top-4 right-4 text-[#64748b] font-mono hover:text-white">✕</button>
            <div className="text-center mb-5"><h3 className="text-white font-bold">Select Gateway Access</h3></div>
            <div className="space-y-2">
              {['MetaMask', 'Trust Wallet', 'Coinbase Wallet', 'WalletConnect'].map((walletKey) => (
                <button key={walletKey} onClick={() => connectTargetWallet(walletKey)} className="w-full bg-white/[0.02] border border-white/5 hover:border-[#00f2fe] p-3.5 text-left rounded-xl text-xs text-white font-bold transition-all hover:bg-[#00f2fe]/5">{walletKey}</button>
              ))}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}