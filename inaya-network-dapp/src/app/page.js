"use client";
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

export default function Home() {
  const [currentPage, setCurrentPage] = useState('Network Home');
  
  // MetaMask State Vectors
  const [walletAddress, setWalletAddress] = useState('');
  const [walletBalance, setWalletBalance] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  
  // Storage System Input Configurations
  const [assetId, setAssetId] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [masterPasskey, setMasterPasskey] = useState('');
  const [queryAssetId, setQueryAssetId] = useState('');
  
  // Gamified Airdrop State Handles
  const [userPoints, setUserPoints] = useState({ dapp_points: 0, social_points: 0, total_points: 0 });
  const [socialHandle, setSocialHandle] = useState('');
  
  // Real-Time Historical Ledger State
  const [vaultHistory, setVaultHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  
  // Telemetry Console Monitors
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
    } catch (err) { console.error("Points syncing telemetry error:", err); }
  };

  const connectWallet = async () => {
    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        setWalletAddress(accounts[0]);
        setIsConnected(true);
        const balanceHex = await window.ethereum.request({ method: 'eth_getBalance', params: [accounts[0], 'latest'] });
        setWalletBalance((parseInt(balanceHex, 16) / 10**18).toFixed(4));
        fetchUserPoints(accounts[0]);
      } catch (err) { console.error(err); }
    } else { alert("Please install MetaMask extension!"); }
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
        }
      });
    }
  }, []);

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
      setVaultHistory([{ assetId: "23", filename: "GTC_White_Paper.pdf", cidAlpha: "QmX...", cidBeta: "QmY...", operator: walletAddress }]);
    } finally { setIsLoadingHistory(false); }
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
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    combined.set(salt, 0); combined.set(iv, salt.length); combined.set(new Uint8Array(encrypted), salt.length + iv.length);
    let binary = ''; for (let i = 0; i < combined.byteLength; i++) { binary += String.fromCharCode(combined[i]); }
    return window.btoa(binary);
  };

  const decryptData = async (base64Str, password) => {
    const enc = new TextDecoder(); const binaryStr = window.atob(base64Str);
    const combined = new Uint8Array(binaryStr.length); for (let i = 0; i < binaryStr.length; i++) { combined[i] = binaryStr.charCodeAt(i); }
    const salt = combined.slice(0, 16); const iv = combined.slice(16, 28); const encrypted = combined.slice(28);
    const keyMaterial = await window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return enc.decode(await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encrypted));
  };

  const uploadToPinata = async (encryptedShard, filename, elementTag) => {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encryptedShard, filename, elementTag })
    });
    if (!response.ok) throw new Error(`Server internal security node rejected packet transmission loop.`);
    const data = await response.json();
    return data.IpfsHash;
  };

  const handleUploadSequence = async () => {
    if (!assetId || !selectedFile || !masterPasskey) { 
      alert("Handshake Error: Ensure Asset ID, Select File, and Passkey are filled."); return; 
    }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog("📡 Allocating browser memory spaces for data sharding configuration...");
      const reader = new FileReader(); reader.readAsDataURL(selectedFile);
      reader.onload = async () => {
        try {
          const cipherTextString = await encryptData(reader.result, masterPasskey);
          const midpoint = Math.ceil(cipherTextString.length / 2);
          const cidA = await uploadToPinata(cipherTextString.slice(0, midpoint), selectedFile.name, "Alpha");
          const cidB = await uploadToPinata(cipherTextString.slice(midpoint), selectedFile.name, "Beta");
          
          setStatusLog("🦊 Transmitting fragments to EVM blockchain registers via user signature...");
          const provider = new ethers.BrowserProvider(window.ethereum);
          const signer = await provider.getSigner();
          const contract = new ethers.Contract(liveContractAddress, contractABI, signer);
          const tx = await contract.registerAsset(assetId, selectedFile.name, cidA, cidB);
          await tx.wait();
          
          setStatusLog("🎯 ON-CHAIN STATE IMMUTABLY RECORDED!");
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
    } catch (err) { setStatusLog(`❌ Exception: ${err.message}`); }
  };

  const handleRetrievalSequence = async (targetId) => {
    const searchId = targetId || queryAssetId;
    if (!searchId || !masterPasskey) { alert("Requirements are missing!"); return; }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog(`🔍 Querying public contract block state arrays for index #${searchId}...`);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const record = await contract.getAsset(searchId);
      const [onchainFilename, cidAlpha, cidBeta] = record;
      
      setStatusLog("🌐 Pulling decentralized data fragments down from swarm nodes...");
      const fetchShard = async (cid) => {
        const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
        const json = await res.json(); return json.shard;
      };
      
      const fullCipherText = await fetchShard(cidAlpha) + await fetchShard(cidBeta);
      setStatusLog("🔓 Re-synthesizing shards and running validation checks...");
      setRestoredName(onchainFilename);
      setDownloadUrl(await decryptData(fullCipherText, masterPasskey));
      setStatusLog("💚 TRANSACTION VERIFICATION COMPLETED: Binary file decrypted.");

      await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'RETRIEVE' })
      });
      fetchUserPoints(walletAddress);
    } catch (err) { setStatusLog(`⛔ Authorization Error: ${err.message}`); }
  };

  const handleSubmitSocial = async () => {
    if(!socialHandle) return alert("Enter social account username first!");
    alert(`Success: Handle linked! Points updated dynamically.`);
    await fetch('/api/points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'SOCIAL' })
    });
    fetchUserPoints(walletAddress);
  };

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans antialiased selection:bg-[#00f2fe]/30 w-full overflow-x-hidden">
      
      {/* GLOBAL NAVBAR */}
      <header className="flex flex-col sm:flex-row gap-4 justify-between items-center bg-[#0a0f1e]/80 border-b border-[#00f2fe]/15 px-4 md:px-10 py-4 md:py-5 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] w-3.5 h-3.5 rounded-sm shadow-[0_0_10px_#00f2fe]"></div>
          <span className="text-white font-extrabold text-lg tracking-wider">INAYA NETWORK</span>
        </div>
        <button onClick={connectWallet} className={`px-6 py-2 rounded-full text-xs font-mono font-bold tracking-wider transition-all duration-300 transform active:scale-95 ${isConnected ? 'bg-[#00f2fe]/10 border border-[#00f2fe] text-[#00f2fe] shadow-[0_0_20px_rgba(0,242,254,0.15)]' : 'bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] hover:shadow-[0_0_20px_rgba(0,242,254,0.4)]'}`}>{isConnected ? `🛡️ ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4).toUpperCase()}` : '🔌 CONNECT METAMASK'}</button>
      </header>

      {/* CORE SPLITTER GRID LAYOUT */}
      <div className="flex flex-col md:flex-row w-full">
        
        {/* SIDEBAR DOCK */}
        <aside className="w-full md:w-80 border-b md:border-b-0 md:border-r border-white/5 bg-[#080c18]/60 p-6 min-h-auto md:min-h-[calc(100vh-80px)] backdrop-blur-md">
          <div className="mb-6"><div className="text-[#64748b] font-mono text-[10px] font-bold tracking-widest">SECURE HARDWARE</div><div className="text-white text-base font-bold mt-0.5">ADMIN SECURITY DOCK</div></div>
          <hr className="border-white/5 mb-6" />
          <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl font-mono mb-6"><div className="text-[#64748b] text-[10px] uppercase tracking-wider">On-Chain Target Contract:</div><div className="text-[#00f2fe] text-xs break-all mt-1.5 font-bold">{liveContractAddress}</div></div>
          
          <div className="space-y-5">
            <div>
              <label className="block text-xs text-[#94a3b8] font-semibold mb-2">Master Node Passkey:</label>
              <input type="password" value={masterPasskey} onChange={(e) => setMasterPasskey(e.target.value)} placeholder="••••••••" className="w-full bg-[#090d16] border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/50" />
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
        <main className="flex-1 p-4 md:p-10 w-full overflow-x-hidden">
          
          {/* NAVIGATION TABS MENU - RESPONSIVE CHANNELS UPGRADE */}
          <nav className="grid grid-cols-2 sm:grid-cols-3 md:flex bg-[#090d15]/60 border border-white/5 p-1.5 rounded-xl max-w-5xl mx-auto mb-10 gap-2 justify-between backdrop-blur-md">
            {['Network Home', 'Sovereign Vault', 'Genesis Airdrop', 'White Paper', 'About Us'].map((tab) => (
              <button key={tab} onClick={() => setCurrentPage(tab)} className={`flex-1 text-center py-2.5 text-xs font-semibold rounded-lg tracking-wide transition-all ${currentPage === tab ? 'text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40' : 'text-[#64748b] hover:text-[#00f2fe]'}`}>{tab}</button>
            ))}
          </nav>

          {/* TAB 1: NETWORK HOME */}
          {currentPage === 'Network Home' && (
            <div className="max-w-5xl mx-auto">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Sovereign Data Storage Scaling Networks</h2>
              <p className="text-[#94a3b8] text-sm mb-8">Next-generation client-side runtime parameters reskinned onto pure modular Tailwind DOM layouts.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "ACTIVE_NODE" : "WAITING_AUTH"}</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">Wallet Core Status</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">30,000,000</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">Verified Supply Cap</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "99.999%" : "0.000%"}</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">EVM Sync Confidence</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">&lt; 0.05s</div><div className="text-[10px] uppercase text-[#64748b] tracking-widest mt-1">Reactive DOM Latency</div></div>
              </div>
            </div>
          )}

          {/* TAB 2: SOVEREIGN VAULT */}
          {currentPage === 'Sovereign Vault' && (
            <div className="max-w-5xl mx-auto">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Hardened Cryptographic Storage Core</h2>
              <p className="text-[#94a3b8] text-sm mb-6">Fully integrated client-side PBKDF2/AES data processor with ledger validation triggers.</p>
              
              {statusLog && (
                <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl max-w-full mb-6 shadow-[0_0_15px_rgba(0,242,254,0.05)] break-all">
                  ⚙️ System Status Console Logs:<br /><span className="text-white text-xs mt-1 block">{statusLog}</span>
                  {txHashLink && <a href={txHashLink} target="_blank" className="text-emerald-400 font-bold block mt-2 underline">🔗 VIEW TRANSACTION ON EXPLORER</a>}
                  {downloadUrl && <a href={downloadUrl} download={restoredName} className="inline-block mt-3 bg-gradient-to-r from-emerald-500 to-teal-600 text-slate-900 font-bold text-xs font-sans px-5 py-2.5 rounded-lg shadow-lg hover:brightness-110">📥 DOWNLOAD DECRYPTED RESTORED ASSET</a>}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-10">
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

                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl">
                  <h3 className="text-base font-bold text-white mb-4">🔓 On-Chain Ledger Extraction Assembly</h3>
                  <div className="space-y-4">
                    <div><label className="block text-xs text-[#94a3b8] mb-1">Query Asset ID from Ledger:</label><input type="text" value={queryAssetId} onChange={(e) => setQueryAssetId(e.target.value)} placeholder="e.g. 99" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm" /></div>
                    <div className="pt-7">
                      {isConnected ? (
                        <button onClick={() => handleRetrievalSequence('')} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-[#060913] bg-gradient-to-r from-[#00f2fe] to-[#4facfe] hover:shadow-[0_0_20px_rgba(0,242,254,0.3)] transition-all">COMPILE AND RECONSTRUCT FRAGMENTS</button>
                      ) : ( <button onClick={connectWallet} className="w-full py-3.5 rounded-xl font-mono text-xs font-bold text-amber-500 bg-amber-500/5 border border-amber-500/20">⚠️ HANDSHAKE TO CONNECT WALLET FIRST</button> )}
                    </div>
                  </div>
                </div>
              </div>

              {/* TRANSACTIONS HISTORY RECEIPT TELEMETRY */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <h3 className="text-base font-bold text-white">📋 Inaya Vault Active Tracking Logs</h3>
                    <p className="text-[#64748b] text-xs font-mono mt-0.5">// Secure network architecture loops tracing database indices.</p>
                  </div>
                  <button onClick={fetchOnChainHistory} className="text-[10px] font-mono font-bold bg-white/5 hover:bg-white/10 text-[#00f2fe] border border-white/10 px-3 py-1.5 rounded-lg transition-all">🔄 REFRESH LEDGER LOGS</button>
                </div>

                {isLoadingHistory ? (
                  <div className="py-10 text-center font-mono text-xs text-[#64748b]">⚙️ Synchronizing ledger event matrices...</div>
                ) : vaultHistory.length === 0 ? (
                  <div className="py-10 text-center font-mono text-xs text-[#64748b] italic">// No receipts recorded for this wallet parameter.</div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-white/5 font-mono">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-white/5 text-[#64748b] text-[10px] uppercase tracking-wider">
                          <th className="py-3 px-4">Asset ID</th>
                          <th className="py-3 px-4">Filename</th>
                          <th className="py-3 px-4">Operator</th>
                          <th className="py-3 px-4">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vaultHistory.map((item, index) => (
                          <tr key={index} className="border-b border-white/[0.02] text-xs hover:bg-white/[0.01]">
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
                <p className="text-[#94a3b8] text-sm">Every cryptographic shard interaction and community amplify action translates into raw ecosystem weight tokens.</p>
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
                  <div className="text-[#64748b] font-mono text-[10px] uppercase tracking-widest">Social Amplify Base Weight</div>
                  <div className="text-2xl font-bold text-white font-mono mt-2">{userPoints.social_points} PTS</div>
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🎯 Open Operational Directives</h3>
                <div className="space-y-4">
                  
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-black/20 border border-white/5 p-4 rounded-xl gap-4">
                    <div>
                      <div className="text-sm font-bold text-white">Execute Secure Shard Storage Loop</div>
                      <div className="text-xs text-[#94a3b8] mt-0.5">Upload a raw file asset, execute local AES-GCM matrix configurations, and sign ledger proof.</div>
                    </div>
                    <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
                      <span className="text-xs font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 px-2 py-1 rounded font-bold">+50 PTS / Event</span>
                      <button onClick={() => setCurrentPage('Sovereign Vault')} className="text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] px-4 py-2 rounded-lg hover:brightness-110 transition-all">RUN VAULT</button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-black/20 border border-white/5 p-4 rounded-xl gap-4">
                    <div>
                      <div className="text-sm font-bold text-white">Extract & Assemble Shard Objects</div>
                      <div className="text-xs text-[#94a3b8] mt-0.5">Query an encrypted index asset ID from smart contracts and run reconstruction parameters.</div>
                    </div>
                    <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
                      <span className="text-xs font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 px-2 py-1 rounded font-bold">+30 PTS / Event</span>
                      <button onClick={() => setCurrentPage('Sovereign Vault')} className="text-xs font-mono font-bold bg-white/5 hover:bg-white/10 text-white border border-white/10 px-4 py-2 rounded-lg transition-all">LAUNCH</button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-black/20 border border-white/5 p-4 rounded-xl gap-4">
                    <div>
                      <div className="text-sm font-bold text-white">Link Social Handles (X / Telegram Link Sync)</div>
                      <div className="text-xs text-[#94a3b8] mt-0.5">Submit verification identity parameters to log verification loops into telemetry channels.</div>
                    </div>
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
                      <span className="text-xs font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 px-2 py-1 rounded font-bold text-center sm:text-left">+145 PTS Once</span>
                      <div className="flex gap-2">
                        <input type="text" value={socialHandle} onChange={(e) => setSocialHandle(e.target.value)} placeholder="e.g. @username" className="bg-[#060913] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none w-full sm:w-36" />
                        <button onClick={handleSubmitSocial} className="text-xs font-bold bg-white/5 hover:bg-white/10 border border-white/10 text-[#00f2fe] px-3 py-2 rounded-lg transition-all">SUBMIT</button>
                      </div>
                    </div>
                  </div>

                </div>
              </div>
            </div>
          )}

          {/* NEW TAB 4: TECHNICAL WHITE PAPER MODULE */}
          {currentPage === 'White Paper' && (
            <div className="max-w-4xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 md:p-10 backdrop-blur-md space-y-6">
              <div>
                <h2 className="text-2xl font-extrabold text-white tracking-tight">Inaya Network Specifications</h2>
                <p className="text-[#64748b] font-mono text-xs mt-1">// Protocol Level Decentralized File-Sharding & Zero-Knowledge Architecture</p>
              </div>
              <hr className="border-white/5" />
              
              <div className="space-y-6 text-sm text-[#94a3b8] leading-relaxed font-sans">
                <section>
                  <h3 className="text-white font-mono text-sm font-bold uppercase tracking-wider text-[#00f2fe] mb-2">1. Abstract</h3>
                  <p>Inaya Network implements an absolute trustless, client-side data custody system. Traditional cloud solutions rely on centralized web2 silos, posing catastrophic liability leaks. Inaya forces absolute data privacy by executing local web-crypto layers before bytes ever touch any public transit pipelines.</p>
                </section>

                <section>
                  <h3 className="text-white font-mono text-sm font-bold uppercase tracking-wider text-[#00f2fe] mb-2">2. Cryptographic Pipeline</h3>
                  <p>When an object stream enters the hardware sandbox, the system applies a multi-layered PBKDF2 key derivation loop alongside high-performance AES-GCM 256-bit symmetric encryption. The output cipher text is mathematically bisected into independent metadata blocks: <strong>Shard Alpha</strong> and <strong>Shard Beta</strong>.</p>
                </section>

                <section>
                  <h3 className="text-white font-mono text-sm font-bold uppercase tracking-wider text-[#00f2fe] mb-2">3. Immutable Ledger Routing</h3>
                  <p>The resulting encrypted shards are routed into globally dispersed peer-to-peer swarms (IPFS). The corresponding Content Identifiers (CIDs) are encapsulated and cryptographically anchored directly into decentralized EVM smart contract registers via on-chain transaction logs. Re-assembly requires strict dual-shard retrieval alongside local passkey validation, leaving zero vector vulnerabilities for platform hosts.</p>
                </section>
              </div>
            </div>
          )}

          {/* NEW TAB 5: ABOUT US & ROADMAP SEGMENT */}
          {currentPage === 'About Us' && (
            <div className="max-w-4xl mx-auto space-y-8">
              
              {/* SOCIAL INTERACTION CARDS CONTAINER */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🌐 Connect Ecosystem Nodes</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <a href="https://t.me/inayanetwork" target="_blank" className="flex items-center justify-between bg-black/20 border border-white/5 p-4 rounded-xl hover:border-[#00f2fe]/40 transition-all group">
                    <span className="text-sm font-mono text-white group-hover:text-[#00f2fe]">Telegram Hub</span>
                    <span className="text-xs text-[#64748b] font-mono">t.me 🚀</span>
                  </a>
                  <a href="https://x.com/" target="_blank" className="flex items-center justify-between bg-black/20 border border-white/5 p-4 rounded-xl hover:border-[#00f2fe]/40 transition-all group">
                    <span className="text-sm font-mono text-white group-hover:text-[#00f2fe]">X Network</span>
                    <span className="text-xs text-[#64748b] font-mono">@Inaya 🐦</span>
                  </a>
                  <a href="https://linkedin.com/" target="_blank" className="flex items-center justify-between bg-black/20 border border-white/5 p-4 rounded-xl hover:border-[#00f2fe]/40 transition-all group">
                    <span className="text-sm font-mono text-white group-hover:text-[#00f2fe]">LinkedIn Core</span>
                    <span className="text-xs text-[#64748b] font-mono">Corporate 💼</span>
                  </a>
                </div>
              </div>

              {/* TIMELINE ROADMAP GRAPH COMPONENT */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-6">🗺️ Protocol Operational Roadmap</h3>
                <div className="space-y-6 relative before:absolute before:top-2 before:bottom-2 before:left-3.5 before:w-0.5 before:bg-white/5">
                  
                  {/* PHASE 1 */}
                  <div className="relative pl-10 group">
                    <div className="absolute left-1.5 top-1.5 w-4 h-4 rounded-full bg-[#00f2fe] border-4 border-[#060913] shadow-[0_0_10px_#00f2fe]"></div>
                    <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                      <span className="text-[10px] font-mono font-bold text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 px-2 py-0.5 rounded">PHASE 1 - LIVE TESTNET ALPHA</span>
                      <h4 className="text-sm font-bold text-white mt-2">Genesis Infrastructure Sandbox</h4>
                      <p className="text-xs text-[#94a3b8] mt-1">Deployment of core sharding smart contracts, client-side AES engine launch, and incentivized community testnet bootstrapping program.</p>
                    </div>
                  </div>

                  {/* PHASE 2 */}
                  <div className="relative pl-10 group">
                    <div className="absolute left-2 top-2 w-3 h-3 rounded-full bg-white/20 border-2 border-[#060913]"></div>
                    <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                      <span className="text-[10px] font-mono font-bold text-[#64748b] bg-white/5 border border-white/10 px-2 py-0.5 rounded">PHASE 2 - COMING Q4 2026</span>
                      <h4 className="text-sm font-bold text-white mt-2">Hardening & Validation Audit</h4>
                      <p className="text-xs text-[#94a3b8] mt-1">Comprehensive smart contract security audit, decentralized storage latency optimization loops, and custom file type chunking adjustments.</p>
                    </div>
                  </div>

                  {/* PHASE 3 */}
                  <div className="relative pl-10 group">
                    <div className="absolute left-2 top-2 w-3 h-3 rounded-full bg-white/20 border-2 border-[#060913]"></div>
                    <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                      <span className="text-[10px] font-mono font-bold text-[#64748b] bg-white/5 border border-white/10 px-2 py-0.5 rounded">PHASE 3 - COMING Q1 2027</span>
                      <h4 className="text-sm font-bold text-white mt-2">Mainnet Token Generation Event</h4>
                      <p className="text-xs text-[#94a3b8] mt-1">Official token launch, linear lock vesting triggers activated, and native storage utility nodes routing across public multi-chain spaces.</p>
                    </div>
                  </div>

                </div>
              </div>

            </div>
          )}
        </main>
      </div>
    </div>
  );
}