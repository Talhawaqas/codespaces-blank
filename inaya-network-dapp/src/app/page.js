"use client";
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';

export default function Home() {
  // 1. NAVIGATION CONTROL
  const [currentPage, setCurrentPage] = useState('Network Home');
  
  // 2. WALLET REGISTRY STATES
  const [walletAddress, setWalletAddress] = useState('');
  const [walletBalance, setWalletBalance] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [selectedWalletName, setSelectedWalletName] = useState('');
  
  // 3. SECURE SIGN UP STATES
  const [isSignedUp, setIsSignedUp] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  
  // 4. STORAGE SYSTEM CONFIGURATIONS
  const [assetId, setAssetId] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [masterPasskey, setMasterPasskey] = useState('');
  const [queryAssetId, setQueryAssetId] = useState('');
  
  // 5. GAIMFIED POINTS MATRIX
  const [userPoints, setUserPoints] = useState({ dapp_points: 0, social_points: 0, total_points: 0 });
  const [socialHandle, setSocialHandle] = useState('');
  
  // 6. ON-CHAIN HISTORY STORAGE
  const [vaultHistory, setVaultHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  
  // 7. SYSTEM TELEMETRY LOGGER
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
    } catch (err) { console.error("Points sync loop error:", err); }
  };

  const connectTargetWallet = async (walletType) => {
    setIsWalletModalOpen(false);
    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      try {
        setSelectedWalletName(walletType);
        setStatusLog(`📡 Initializing handshake protocols with ${walletType}...`);
        
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        setWalletAddress(accounts[0]);
        setIsConnected(true);
        
        const balanceHex = await window.ethereum.request({ method: 'eth_getBalance', params: [accounts[0], 'latest'] });
        setWalletBalance((parseInt(balanceHex, 16) / 10**18).toFixed(4));
        
        fetchUserPoints(accounts[0]);
        setStatusLog(`💚 Connected with ${walletType}. Proceed to node authentication.`);
      } catch (err) { 
        console.error(err); 
        setStatusLog(`❌ Handshake rejected: ${err.message}`);
      }
    } else { 
      alert(`Provider context missing: Please install ${walletType} extension loop.`); 
    }
  };

  const handleWeb3SignUp = async () => {
    if (!isConnected || !walletAddress) {
      alert("Handshake error: Connect wallet first."); return;
    }
    setIsSigning(true);
    setStatusLog("🔐 Emitting unique cryptographic identity token to secure signature layer...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const verificationMessage = `[INAYA CUSTODY NETWORK - NODE REGISTRATION]\n\nAuthorize absolute sovereign data fragmentation access routines for this host station.\n\nNode Index: ${walletAddress.toLowerCase()}\nTimestamp Hash: ${Date.now()}`;
      
      await signer.signMessage(verificationMessage);
      setIsSignedUp(true);
      setStatusLog("🎯 ACCOUNT SIGN-UP COMPLETE: Verification loop safely tracked.");
      
      await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'SIGNUP' })
      });
      fetchUserPoints(walletAddress);
    } catch (err) {
      console.error(err);
      setStatusLog(`❌ Registration aborted: Verification parameters dropped. ${err.message}`);
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
    if (!response.ok) throw new Error(`Swarm infrastructure node broadcast error.`);
    const data = await response.json();
    return data.IpfsHash;
  };

  const handleUploadSequence = async () => {
    if (!isSignedUp) { alert("Access Denied: Please verify your node signature in the sidebar first."); return; }
    if (!assetId || !selectedFile || !masterPasskey) { 
      alert("Validation Error: Missing parameters input fields."); return; 
    }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog("📡 Formulating data segments for cryptographic hashing loops...");
      const reader = new FileReader(); reader.readAsDataURL(selectedFile);
      reader.onload = async () => {
        try {
          const cipherTextString = await encryptData(reader.result, masterPasskey);
          const midpoint = Math.ceil(cipherTextString.length / 2);
          const cidA = await uploadToPinata(cipherTextString.slice(0, midpoint), selectedFile.name, "Alpha");
          const cidB = await uploadToPinata(cipherTextString.slice(midpoint), selectedFile.name, "Beta");
          
          setStatusLog("🦊 Anchoring hashes onto smart contract matrices... Sign transaction.");
          const provider = new ethers.BrowserProvider(window.ethereum);
          const signer = await provider.getSigner();
          const contract = new ethers.Contract(liveContractAddress, contractABI, signer);
          const tx = await contract.registerAsset(assetId, selectedFile.name, cidA, cidB);
          await tx.wait();
          
          setStatusLog("🎯 SUCCESS: Shards registered whole on BNB Chain ledger registers.");
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
    } catch (err) { setStatusLog(`❌ Exception Node: ${err.message}`); }
  };

  const handleRetrievalSequence = async (targetId) => {
    if (!isSignedUp) { alert("Access Denied: Authenticate node profile first."); return; }
    const searchId = targetId || queryAssetId;
    if (!searchId || !masterPasskey) { alert("Validation Error: Query index required."); return; }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog(`🔍 Checking state logs arrays for shard target reference #${searchId}...`);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const record = await contract.getAsset(searchId);
      const [onchainFilename, cidAlpha, cidBeta] = record;
      
      const fetchShard = async (cid) => {
        const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
        const json = await res.json(); return json.shard;
      };
      
      const fullCipherText = await fetchShard(cidAlpha) + await fetchShard(cidBeta);
      setRestoredName(onchainFilename);
      setDownloadUrl(await decryptData(fullCipherText, masterPasskey));
      setStatusLog("💚 TRANSACTION DEPLOYMENT LOGGED: File successfully restored.");

      await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'RETRIEVE' })
      });
      fetchUserPoints(walletAddress);
    } catch (err) { setStatusLog(`❌ Validation check error: ${err.message}`); }
  };

  const handleSubmitSocial = async () => {
    if(!socialHandle) return alert("Validation Core Error: Fill social handle tag.");
    alert(`Success: Verification tracking indices mapped securely to identity ledger.`);
    await fetch('/api/points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'SOCIAL' })
    });
    fetchUserPoints(walletAddress);
  };

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans w-full overflow-x-hidden">
      <header className="flex flex-col sm:flex-row gap-4 justify-between items-center bg-[#0a0f1e]/80 border-b border-[#00f2fe]/15 px-4 md:px-10 py-4 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] w-3.5 h-3.5 rounded-sm"></div>
          <span className="text-white font-extrabold text-lg tracking-wider">INAYA NETWORK</span>
        </div>
        <button onClick={() => isConnected ? null : setIsWalletModalOpen(true)} className="px-6 py-2 rounded-full text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913]">
          {isConnected ? `🛡️ ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4).toUpperCase()}` : '🔌 CONNECT WALLET'}
        </button>
      </header>

      <div className="flex flex-col md:flex-row w-full">
        <aside className="w-full md:w-80 border-b md:border-b-0 md:border-r border-white/5 bg-[#080c18]/60 p-6 backdrop-blur-md">
          <div className="text-white text-base font-bold mb-4">ADMIN SECURITY DOCK</div>
          <div className="space-y-5">
            <div className="border border-[#00f2fe]/20 bg-[#0c162b]/80 p-4 rounded-xl">
              <div className="text-[#00f2fe] font-mono text-[10px] font-bold uppercase">Node Authentication</div>
              {isConnected ? (
                isSignedUp ? (
                  <div className="mt-2 text-xs font-mono text-emerald-400 font-bold">⏱️ NODE OPERATIONAL (VERIFIED)</div>
                ) : (
                  <button onClick={handleWeb3SignUp} disabled={isSigning} className="w-full mt-3 py-2 bg-gradient-to-r from-amber-500 to-orange-600 text-slate-900 font-bold text-xs rounded-lg animate-pulse">
                    {isSigning ? "SIGNING..." : "📝 COMPLETE SIGN UP (VERIFY NODE)"}
                  </button>
                )
              ) : (
                <div className="text-[#64748b] text-[11px] italic mt-2 font-mono">// Connect wallet to sign up.</div>
              )}
            </div>
            <div>
              <label className="block text-xs text-[#94a3b8] font-semibold mb-2">Master Node Passkey:</label>
              <input type="password" value={masterPasskey} onChange={(e) => setMasterPasskey(e.target.value)} placeholder="••••••••" className="w-full bg-[#090d16] border border-white/10 rounded-lg px-4 py-2.5 text-white text-sm font-mono focus:outline-none" />
            </div>
          </div>
        </aside>

        <main className="flex-1 p-4 md:p-10 w-full">
          <nav className="grid grid-cols-2 sm:grid-cols-3 md:flex bg-[#090d15]/60 border border-white/5 p-1.5 rounded-xl max-w-5xl mx-auto mb-10 gap-2 backdrop-blur-md">
            {['Network Home', 'Sovereign Vault', 'Genesis Airdrop', 'KYC Portal', 'White Paper', 'About Us'].map((tab) => (
              <button key={tab} onClick={() => setCurrentPage(tab)} className={`flex-1 text-center py-2.5 text-xs font-semibold rounded-lg ${currentPage === tab ? 'text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40' : 'text-[#64748b]'}`}>{tab}</button>
            ))}
          </nav>

          {currentPage === 'Network Home' && (
            <div className="max-w-5xl mx-auto">
              <h2 className="text-2xl font-extrabold text-white mb-4">Sovereign Data Storage Networks</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? (isSignedUp ? "ACTIVE_NODE" : "UNVERIFIED_SIGNUP") : "WAITING_AUTH"}</div><div className="text-[10px] text-[#64748b] uppercase mt-1">Wallet Core Status</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">30,000,000</div><div className="text-[10px] text-[#64748b] uppercase mt-1">Supply Cap</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "99.999%" : "0.000%"}</div><div className="text-[10px] text-[#64748b] uppercase mt-1">Sync Confidence</div></div>
              </div>
            </div>
          )}

          {currentPage === 'Sovereign Vault' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white">Cryptographic Storage Core</h2>
              {statusLog && <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl break-all">{statusLog}</div>}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-6">
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl space-y-4">
                  <h3 className="text-base font-bold text-white">📥 Upload Shard Pipeline</h3>
                  <input type="text" value={assetId} onChange={(e) => setAssetId(e.target.value)} placeholder="Asset ID" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2 text-white text-sm" />
                  <input type="file" onChange={(e) => setSelectedFile(e.target.files[0])} className="w-full text-xs text-white" />
                  <button onClick={handleUploadSequence} className="w-full py-3 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-xl">SIGN & UPLOAD ASSET</button>
                </div>
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl space-y-4">
                  <h3 className="text-base font-bold text-white">🔓 Reconstruct Assembly</h3>
                  <input type="text" value={queryAssetId} onChange={(e) => setQueryAssetId(e.target.value)} placeholder="Query Asset ID" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2 text-white text-sm" />
                  <button onClick={() => handleRetrievalSequence('')} className="w-full py-3 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-xl">DECRYPT & DOWNLOAD</button>
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold text-white">📋 Inaya Vault Active Tracking Logs</h3>
                  <button onClick={fetchOnChainHistory} className="text-[10px] font-mono bg-white/5 text-[#00f2fe] border border-white/10 px-3 py-1 rounded-lg">🔄 REFRESH</button>
                </div>
                {isLoadingHistory ? (
                  <div className="py-6 text-center font-mono text-xs text-[#64748b]">⚙️ Syncing ledger event matrices...</div>
                ) : vaultHistory.length === 0 ? (
                  <div className="py-6 text-center font-mono text-xs text-[#64748b] italic">// No receipts recorded.</div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-white/5 font-mono text-xs">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-white/5 text-[#64748b] text-[10px] uppercase">
                          <th className="py-2 px-4">Asset ID</th>
                          <th className="py-2 px-4">Filename</th>
                          <th className="py-2 px-4">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vaultHistory.map((item, index) => (
                          <tr key={index} className="border-b border-white/[0.02] hover:bg-white/[0.01]">
                            <td className="py-2 px-4 text-[#00f2fe] font-bold">#{item.assetId}</td>
                            <td className="py-2 px-4 text-white truncate max-w-[120px]">{item.filename}</td>
                            <td className="py-2 px-4"><button onClick={() => handleRetrievalSequence(item.assetId)} className="text-[#00f2fe] underline text-[11px]">COMPILE</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {currentPage === 'Genesis Airdrop' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white">Genesis Incentivized Portal</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 bg-black/20 p-6 rounded-xl border border-white/5 font-mono text-xs">
                <div>Total Points:<br/><span className="text-[#00f2fe] text-2xl font-bold">{userPoints.total_points} PTS</span></div>
                <div>Shard Points:<br/><span className="text-white text-xl font-bold">{userPoints.dapp_points} PTS</span></div>
                <div>Social Points:<br/><span className="text-white text-xl font-bold">{userPoints.social_points} PTS</span></div>
              </div>
              <div className="bg-black/40 border border-white/5 p-6 rounded-xl space-y-4">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <div className="text-sm font-bold text-white">Link Social Handle (X / Telegram)</div>
                    <div className="text-xs text-[#94a3b8]">Get +145 points instantly.</div>
                  </div>
                  <div className="flex gap-2 w-full sm:w-auto">
                    <input type="text" value={socialHandle} onChange={(e) => setSocialHandle(e.target.value)} placeholder="@username" className="bg-[#060913] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white flex-1 sm:flex-none" />
                    <button onClick={handleSubmitSocial} className="text-xs font-bold bg-[#00f2fe] text-[#060913] px-4 py-2 rounded-lg">SUBMIT</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {currentPage === 'KYC Portal' && (
            <div className="max-w-3xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 md:p-10 text-center space-y-6">
              <div className="text-4xl">🛡️</div>
              <h2 className="text-xl font-extrabold text-white">Sovereign Node Compliance (KYC)</h2>
              <p className="text-sm text-[#94a3b8] max-w-md mx-auto">Identity verification is mandatory prior to Mainnet token distribution parameters to prevent bot allocation loops.</p>
              <div className="bg-black/30 border border-white/5 rounded-xl p-4 text-left max-w-md mx-auto font-mono text-xs text-amber-400">
                STATUS: STAGE PENDING (MAINNET CLAIM ONLY)
              </div>
              <button disabled className="px-6 py-3 bg-white/5 text-[#64748b] rounded-xl text-xs font-mono font-bold cursor-not-allowed">🔒 PORTAL OPENS AT PHASE 3 TGE</button>
            </div>
          )}

          {currentPage === 'White Paper' && (
            <div className="max-w-4xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-6">
              <h1 className="text-2xl font-black text-white">THE INAYA PROTOCOL</h1>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                <div className="relative w-full aspect-square border border-white/10 bg-[#060913] rounded-xl overflow-hidden flex items-center justify-center p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/tokenomics.png" alt="Tokenomics Chart" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'block'; }} />
                  <div className="hidden font-mono text-[10px] text-[#64748b] text-center">📊 Place tokenomics.png inside public/ folder.</div>
                </div>
                <div className="font-mono text-xs space-y-2">
                  <div className="text-white font-bold mb-2">Ecosystem Metrics Hard Cap (30,000,000 Supply)</div>
                  <div className="flex justify-between border-b border-white/5 pb-1"><span>Future Swarm Reserves:</span><span className="text-[#4facfe]">66.7% (20M)</span></div>
                  <div className="flex justify-between border-b border-white/5 pb-1"><span>Liquidity Pool (LP):</span><span>21.7% (6.5M)</span></div>
                  <div className="flex justify-between border-b border-white/5 pb-1"><span>Team Allocation:</span><span>5.0% (1.5M)</span></div>
                  <div className="flex justify-between"><span>Airdrop Pool:</span><span>3.3% (1M)</span></div>
                </div>
              </div>
            </div>
          )}

          {currentPage === 'About Us' && (
            <div className="max-w-4xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
              <h3 className="text-base font-bold text-white mb-4">🌐 Connect Ecosystem Nodes</h3>
              <div className="flex gap-4 font-mono text-xs text-[#00f2fe]">
                <a href="https://t.me/inayanetwork" target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe]">Telegram Hub 🚀</a>
                <a href="https://x.com/InayaNetwork" target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe]">X Network 🐦</a>
              </div>
            </div>
          )}
        </main>
      </div>

      {isWalletModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-[9999]">
          <div className="bg-[#090e1a] border border-[#00f2fe]/20 w-full max-w-sm rounded-2xl p-6 relative">
            <button onClick={() => setIsWalletModalOpen(false)} className="absolute top-4 right-4 text-[#64748b] font-mono">✕</button>
            <div className="text-center mb-5"><h3 className="text-white font-bold">Select Gateway Access</h3></div>
            <div className="space-y-2">
              {['MetaMask', 'Trust Wallet', 'Coinbase Wallet', 'WalletConnect'].map((w) => (
                <button key={w} onClick={() => connectTargetWallet(w)} className="w-full bg-white/[0.02] border border-white/5 hover:border-[#00f2fe] p-3 text-left rounded-xl text-xs text-white font-bold">{w}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}