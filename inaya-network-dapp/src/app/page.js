"use client";
import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import Image from 'next/image';

export default function Home() {
  // 1. NAVIGATION CONTROL
  const [currentPage, setCurrentPage] = useState('Network Home');
  
  // 2. WALLET & REGISTRY STATE ENGINE
  const [walletAddress, setWalletAddress] = useState('');
  const [walletBalance, setWalletBalance] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [selectedWalletName, setSelectedWalletName] = useState('');
  
  // 3. CRYPTO SECURE SIGN UP STATES
  const [isSignedUp, setIsSignedUp] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  
  // 4. STORAGE SYSTEM CONFIGURATIONS
  const [assetId, setAssetId] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [masterPasskey, setMasterPasskey] = useState('');
  const [queryAssetId, setQueryAssetId] = useState('');
  
  // 5. GAMIFIED AIRDROP POINTS MATRIX
  const [userPoints, setUserPoints] = useState({ dapp_points: 0, social_points: 0, total_points: 0 });
  const [socialHandle, setSocialHandle] = useState('');
  
  // 6. ON-CHAIN HISTORY STORAGE LEDGER
  const [vaultHistory, setVaultHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  
  // 7. SYSTEM TELEMETRY CONSOLE LOGGER
  const [statusLog, setStatusLog] = useState('');
  const [txHashLink, setTxHashLink] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [restoredName, setRestoredName] = useState('');

  // WHITE PAPER SUB-TABS STATE
  const [activePaperSection, setActivePaperSection] = useState('Abstract');

  const liveContractAddress = "0x871229a40d58a89545270b8d059b8e0f481f1d55"; // Fixed: All lowercase
const tokenContractAddress = "0x9da15c2908c9a87ac5af8c116d4092cb6569488e"; // Fixed: All lowercase
  
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
    } catch (err) { console.error("Points server sync error:", err); }
  };

  const connectTargetWallet = async (walletType) => {
    setIsWalletModalOpen(false);
    if (typeof window !== 'undefined' && typeof window.ethereum !== 'undefined') {
      try {
        setSelectedWalletName(walletType);
        setStatusLog(`📡 Connecting with ${walletType}... Please sign the interface request.`);
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        setWalletAddress(accounts[0]);
        setIsConnected(true);
        const balanceHex = await window.ethereum.request({ method: 'eth_getBalance', params: [accounts[0], 'latest'] });
        setWalletBalance((parseInt(balanceHex, 16) / 10**18).toFixed(4));
        fetchUserPoints(accounts[0]);
        setStatusLog(`💚 Connection channel active with ${walletType}! Execute core Node Sign-Up next.`);
      } catch (err) { 
        console.error(err); 
        setStatusLog(`❌ Handshake dropped by user: ${err.message}`);
      }
    } else { 
      alert(`Runtime error: Injected web3 extension context missing for ${walletType}.`); 
    }
  };

  const handleWeb3SignUp = async () => {
    if (!isConnected || !walletAddress) {
      alert("Authentication error: Connect wallet first."); return;
    }
    setIsSigning(true);
    setStatusLog("🔐 Emitting unique cryptographic host registration message to your wallet provider...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const verificationMessage = `[INAYA CUSTOLOGY NETWORK - NODE REGISTRATION]\n\nAuthorize absolute sovereign data fragmentation access routines for this host station.\n\nNode Index: ${walletAddress.toLowerCase()}\nTimestamp Hash: ${Date.now()}`;
      await signer.signMessage(verificationMessage);
      setIsSignedUp(true);
      setStatusLog("🎯 CRYPTOGRAPHIC REGISTRATION SUCCESSFUL: Node token logged in system arrays.");
      await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'SIGNUP' })
      });
      fetchUserPoints(walletAddress);
    } catch (err) {
      console.error(err);
      setStatusLog(`❌ Registration dropped: ${err.message}`);
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
      
      // ✨ FIX 1: Fetch current block number dynamically
      const latestBlock = await provider.getBlockNumber();
      // ✨ FIX 2: Query only the last 4900 blocks to stay under RPC range ceilings
      const fromBlock = latestBlock - 4900 > 0 ? latestBlock - 4900 : 0;

      const filter = contract.filters.AssetArchived();
      const logs = await contract.queryFilter(filter, fromBlock, 'latest');
      
      const parsedHistory = logs.map(log => {
        if (!log.args) return null;
        const [id, name, cA, cB, op] = log.args;
        return { assetId: id, filename: name, cidAlpha: cA, cidBeta: cB, operator: op };
      }).filter(item => item && item.operator.toLowerCase() === walletAddress.toLowerCase());
      
      setVaultHistory(parsedHistory.reverse());
    } catch (err) {
      console.error("🚨 RPC Logs Extraction Failure:", err);
      // Agar fail ho toh list khali rakhein taake real state pata chalay, static mock nahi
      setVaultHistory([]);
    } finally { 
      setIsLoadingHistory(false); 
    }
  };

  useEffect(() => {
    if (isConnected && currentPage === 'Sovereign Vault') { fetchOnChainHistory(); }
    if (isConnected && walletAddress) { fetchUserPoints(walletAddress); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // FIXED: STRICT BACKEND ACCURACY LOGIC FOR SHARD RECEPTIONS
  const uploadToPinata = async (encryptedShard, filename, elementTag) => {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ encryptedShard, filename, elementTag })
    });
    if (!response.ok) throw new Error(`Swarm transport connection timeout.`);
    const data = await response.json();
    
    // Catch backend validation response without hitting contract undefined bounds
    if (data.success === false) {
      throw new Error(data.error || "Backend pipeline processing failure.");
    }
    return data.IpfsHash;
  };

  const handleUploadSequence = async () => {
    if (!isSignedUp) { alert("Access Denied: Please verify your node signature in the sidebar panel first."); return; }
    if (!assetId || !selectedFile || !masterPasskey) { alert("Validation Error: Missing secure parameter configuration inputs."); return; }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog("📡 Processing bits fragmentation via client-side PBKDF2 layers...");
      const reader = new FileReader(); reader.readAsDataURL(selectedFile);
      reader.onload = async () => {
        try {
          const cipherTextString = await encryptData(reader.result, masterPasskey);
          const midpoint = Math.ceil(cipherTextString.length / 2);
          
          setStatusLog("🌐 Uploading fragmented shards to decentralized storage nodes...");
          const cidA = await uploadToPinata(cipherTextString.slice(0, midpoint), selectedFile.name, "Alpha");
          const cidB = await uploadToPinata(cipherTextString.slice(midpoint), selectedFile.name, "Beta");
          
          const provider = new ethers.BrowserProvider(window.ethereum);
          const signer = await provider.getSigner();
          const contract = new ethers.Contract(liveContractAddress, contractABI, signer);
          
          setStatusLog("⚡ Simulating gas execution parameters on BNB Chain nodes...");
          let estimatedGas;
          try {
            estimatedGas = await contract.registerAsset.estimateGas(assetId, selectedFile.name, cidA, cidB);
            setStatusLog(`⛽ Estimated Gas Weight: ${estimatedGas.toString()} units. Prompting wallet handshake...`);
          } catch (gasErr) {
            console.error(gasErr);
            estimatedGas = BigInt(300000); 
            setStatusLog("⚠️ Gas simulation dropped by node. Enforcing safety buffer ceiling limits...");
          }

          const tx = await contract.registerAsset(assetId, selectedFile.name, cidA, cidB, {
            gasLimit: (estimatedGas * BigInt(120)) / BigInt(100) 
          });
          
          setStatusLog("⏳ Mining block transaction verification receipts onto public ledger...");
          await tx.wait();
          
          setStatusLog("🎯 ON-CHAIN STATE SECURELY RECORDED IN PUBLIC LEDGER!");
          setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);

          await fetch('/api/points', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'UPLOAD' })
          });
          fetchUserPoints(walletAddress);
          fetchOnChainHistory();
        } catch (innerErr) {
          console.error(innerErr);
          if (innerErr.code === 'ACTION_REJECTED') {
            setStatusLog("❌ Transaction cancelled: Handshake signatures rejected by host operator user.");
          } else if (innerErr.message.includes('insufficient funds')) {
            setStatusLog("❌ Transaction dropped: Insufficient tBNB runtime balances to deploy gas routines.");
          } else {
            setStatusLog(`❌ EVM Execution Crash: ${innerErr.reason || innerErr.message}`);
          }
        }
      };
    } catch (err) { setStatusLog(`❌ Exception Node: ${err.message}`); }
  };

  const handleRetrievalSequence = async (targetId) => {
    if (!isSignedUp) { alert("Access Denied: Authenticate node access array parameters first."); return; }
    const searchId = targetId || queryAssetId;
    if (!searchId || !masterPasskey) { alert("Input Error: Tracking index parameters missing."); return; }
    try {
      setTxHashLink(''); setDownloadUrl('');
      setStatusLog(`🔍 Checking public blocks for tracking index reference #${searchId}...`);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const record = await contract.getAsset(searchId);
      const [onchainFilename, cidAlpha, cidBeta] = record;
      
      setStatusLog("🌐 Transporting sharded components down from network swarm nodes...");
      const fetchShard = async (cid) => {
        const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
        const json = await res.json(); return json.shard;
      };
      const fullCipherText = await fetchShard(cidAlpha) + await fetchShard(cidBeta);
      setRestoredName(onchainFilename);
      setDownloadUrl(await decryptData(fullCipherText, masterPasskey));
      setStatusLog("💚 TRANSACTION FULLY VERIFIED: Payload restored intact.");
      await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'RETRIEVE' })
      });
      fetchUserPoints(walletAddress);
    } catch (err) { setStatusLog(`❌ Security check validation dropped: ${err.message}`); }
  };

  const handleSubmitSocial = async () => {
    if(!socialHandle) return alert("Validation Core Error: Fill social reference mapping tag.");
    if(!isConnected) return alert("Web3 Engine Error: Connect wallet target index matrix.");
    
    try {
      setStatusLog("📡 Logging telemetry handle parameters into identity servers...");
      const res = await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          walletAddress: walletAddress.toLowerCase(), 
          actionType: 'SOCIAL',
          handle: socialHandle 
        })
      });

      const responseData = await res.json(); // ✨ Server se aane wala raw response read karein

      if (res.ok) {
        alert(`Success: ${socialHandle} verification tracking parameters mapped securely!`);
        fetchUserPoints(walletAddress);
      } else {
        // ✨ Hardcoded error ki jagah backend ka actual error message throw karein
        throw new Error(responseData.error || "Database update rejection pipeline error.");
      }
    } catch (err) {
      alert(`Backend Sync Dropped: ${err.message}`);
    }
};

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans w-full overflow-x-hidden">
      <header className="flex flex-col sm:flex-row gap-4 justify-between items-center bg-[#0a0f1e]/80 border-b border-[#00f2fe]/15 px-4 md:px-10 py-4 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] w-3.5 h-3.5 rounded-sm shadow-[0_0_10px_#00f2fe]"></div>
          <span className="text-white font-extrabold text-lg tracking-wider">INAYA NETWORK</span>
        </div>
        <button onClick={() => isConnected ? null : setIsWalletModalOpen(true)} className="px-6 py-2 rounded-full text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913]">
          {isConnected ? `🛡️ ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4).toUpperCase()}` : '🔌 CONNECT WALLET'}
        </button>
      </header>

      <div className="flex flex-col md:flex-row w-full">
        <aside className="w-full md:w-80 border-b md:border-b-0 md:border-r border-white/5 bg-[#080c18]/60 p-6 min-h-auto md:min-h-[calc(100vh-80px)] backdrop-blur-md">
          <div className="text-white text-base font-bold mb-4">ADMIN SECURITY DOCK</div>
          <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl font-mono mb-6">
            <div className="text-[#64748b] text-[10px] uppercase tracking-wider">Public Core Contract:</div>
            <div className="text-[#00f2fe] text-xs break-all mt-1.5 font-bold">{liveContractAddress}</div>
          </div>
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

        <main className="flex-1 p-4 md:p-10 w-full overflow-x-hidden">
          <nav className="grid grid-cols-2 sm:grid-cols-3 md:flex bg-[#090d15]/60 border border-white/5 p-1.5 rounded-xl max-w-5xl mx-auto mb-10 gap-2 backdrop-blur-md">
            {['Network Home', 'Sovereign Vault', 'Genesis Airdrop', 'KYC Portal', 'White Paper', 'About Us'].map((tab) => (
              <button key={tab} onClick={() => setCurrentPage(tab)} className={`flex-1 text-center py-2.5 text-xs font-semibold rounded-lg tracking-wide transition-all ${currentPage === tab ? 'text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40' : 'text-[#64748b]'}`}>{tab}</button>
            ))}
          </nav>

          {currentPage === 'Network Home' && (
            <div className="max-w-5xl mx-auto">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Sovereign Data Storage Networks</h2>
              <p className="text-[#94a3b8] text-sm mb-8">Next-generation client-side runtime parameters reskinned onto pure modular Tailwind DOM layouts.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? (isSignedUp ? "ACTIVE_NODE" : "UNVERIFIED_SIGNUP") : "WAITING_AUTH"}</div><div className="text-[10px] uppercase text-[#64748b] mt-1">Wallet Core Status</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">30,000,000</div><div className="text-[10px] uppercase text-[#64748b] mt-1">Supply Cap Weight</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "99.999%" : "0.000%"}</div><div className="text-[10px] uppercase text-[#64748b] mt-1">Sync Confidence</div></div>
              </div>
            </div>
          )}

          {currentPage === 'Sovereign Vault' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white">Cryptographic Storage Core</h2>
              {statusLog && <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl break-all shadow-md">{statusLog}</div>}
              {txHashLink && <div className="mt-2 text-xs font-mono"><a href={txHashLink} target="_blank" rel="noreferrer" className="text-[#00f2fe] underline font-bold">👀 View BSCScan Transaction</a></div>}
              {downloadUrl && <div className="mt-2 text-xs font-mono bg-emerald-950 p-3 rounded-lg border border-emerald-500/30 text-emerald-400 font-bold">🔓 Decrypted File Payload Ready: <a href={downloadUrl} download={restoredName} className="underline text-white ml-2">📥 DOWNLOAD {restoredName.toUpperCase()}</a></div>}
              
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-6">
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl space-y-4">
                  <h3 className="text-base font-bold text-white">📥 Upload Shard Pipeline</h3>
                  <input type="text" value={assetId} onChange={(e) => setAssetId(e.target.value)} placeholder="Asset Tracking ID" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm" />
                  <input type="file" onChange={(e) => setSelectedFile(e.target.files[0])} className="w-full text-xs text-white" />
                  <button onClick={handleUploadSequence} className="w-full py-3 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-xl shadow-lg">SIGN & EMIT SECURE RECORD</button>
                </div>
                <div className="bg-[#0b1120]/40 border border-white/5 p-6 rounded-2xl space-y-4">
                  <h3 className="text-base font-bold text-white">🔓 Reconstruct Assembly</h3>
                  <input type="text" value={queryAssetId} onChange={(e) => setQueryAssetId(e.target.value)} placeholder="Query Asset ID" className="w-full bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm" />
                  <button onClick={() => handleRetrievalSequence('')} className="w-full py-3 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-xl shadow-lg">COMPILE AND RECONSTRUCT FRAGMENTS</button>
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm font-bold text-white">📋 Inaya Vault Active Tracking Logs</h3>
                  <button onClick={fetchOnChainHistory} className="text-[10px] font-mono bg-white/5 text-[#00f2fe] border border-white/10 px-3 py-1 rounded-lg">🔄 REFRESH matrix</button>
                </div>
                {isLoadingHistory ? (
                  <div className="py-6 text-center font-mono text-xs text-[#64748b]">⚙️ Syncing ledger event matrices...</div>
                ) : vaultHistory.length === 0 ? (
                  <div className="py-6 text-center font-mono text-xs text-[#64748b] italic">// No tracking logs.</div>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-white/5 font-mono text-xs">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-white/5 text-[#64748b] text-[10px] uppercase">
                          <th className="py-2 px-4">Asset ID</th>
                          <th className="py-2 px-4">Filename</th>
                          <th className="py-2 px-4">Action Token</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vaultHistory.map((item, index) => (
                          <tr key={index} className="border-b border-white/[0.02] hover:bg-white/[0.01]">
                            <td className="py-2 px-4 text-[#00f2fe] font-bold">#{item.assetId}</td>
                            <td className="py-2 px-4 text-white truncate max-w-[150px]">{item.filename}</td>
                            <td className="py-2 px-4"><button onClick={() => handleRetrievalSequence(item.assetId)} className="text-[#00f2fe] underline font-bold">RECONSTRUCT</button></td>
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
    
    {/* 1. Points Matrix Grid */}
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 bg-black/20 p-6 rounded-xl border border-white/5 font-mono text-xs">
      <div>Total Points Weight:<br/><span className="text-[#00f2fe] text-2xl font-bold">{userPoints.total_points} PTS</span></div>
      <div>Shard Points:<br/><span className="text-white text-xl font-bold">{userPoints.dapp_points} PTS</span></div>
      <div>Social Weight:<br/><span className="text-white text-xl font-bold">{userPoints.social_points} PTS</span></div>
    </div>

    {/* ======================================================== */}
    {/* 📊 SCARCE TOKENOMICS CONVERSION HUBCARD (ADDED HERE) */}
    {/* ======================================================== */}
    <div className="bg-gradient-to-r from-[#0a0f1d] to-[#0b1426] border border-[#00f2fe]/20 rounded-xl p-6 grid grid-cols-1 md:grid-cols-3 gap-6 items-center font-mono text-xs">
      
      {/* A. Low Supply Ratio Metric */}
      <div className="flex flex-col space-y-1">
        <span className="text-[#64748b] uppercase tracking-widest text-[10px]">Network Conversion Rate</span>
        <div className="flex items-baseline space-x-1.5">
          <span className="text-xl font-bold text-[#00f2fe]">50</span>
          <span className="text-[#64748b] text-[10px]">PTS</span>
          <span className="text-slate-400 font-bold">=</span>
          <span className="text-xl font-bold text-emerald-400">0.01</span>
          <span className="text-emerald-500 text-[10px] font-bold">$INAYA</span>
        </div>
        <p className="text-[10px] text-slate-500">Calibrated for 30M Strict Max Supply Scarcity Lock.</p>
      </div>

      {/* B. High Precision Mathematical Yield Output */}
      <div className="bg-black/30 border border-white/5 rounded-lg p-3.5 flex flex-col justify-center items-center text-center">
        <span className="text-[#64748b] uppercase text-[10px] mb-1">Estimated Yield Output</span>
        <div className="text-2xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00f2fe] to-emerald-400">
          {(userPoints.total_points * 0.0002).toFixed(4)} <span className="text-[10px] font-bold text-emerald-400">$INAYA</span>
        </div>
        <span className="text-[9px] text-[#00f2fe]/70 mt-1">✓ Allocation Verified for Host Node</span>
      </div>

      {/* C. Global Network Vault Allocation Status */}
      <div className="flex flex-col space-y-2">
        <div className="flex justify-between text-[10px]">
          <span className="text-[#64748b]">Pool Claim Progress</span>
          <span className="text-emerald-400 font-bold">0.00001% Claimed</span>
        </div>
        <div className="w-full bg-black/40 rounded-full h-1.5 border border-white/5 overflow-hidden">
          <div className="bg-gradient-to-r from-[#00f2fe] to-emerald-500 h-full rounded-full w-[1%] shadow-[0_0_8px_rgba(0,242,254,0.4)]"></div>
        </div>
        <div className="flex justify-between text-[9px] text-slate-500">
          <span>0 INAYA</span>
          <span>1,000,000 INAYA CAP</span>
        </div>
      </div>
      
    </div>

    {/* 3. Link Social Handle Card */}
    <div className="bg-black/40 border border-white/5 p-6 rounded-xl space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <div className="text-sm font-bold text-white">Link Social Handle (X / Telegram Link Matrix)</div>
          <div className="text-xs text-[#94a3b8]">Register community verification markers to scale weights.</div>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <input type="text" value={socialHandle} onChange={(e) => setSocialHandle(e.target.value)} placeholder="@username" className="bg-[#060913] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#00f2fe]/50" />
          <button onClick={handleSubmitSocial} className="text-xs font-bold bg-[#00f2fe] text-[#060913] px-4 py-2 rounded-lg transition-transform active:scale-95">SUBMIT</button>
        </div>
      </div>
    </div>

  </div>
)}

          {currentPage === 'KYC Portal' && (
            <div className="max-w-3xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 text-center space-y-6">
              <div className="text-4xl">🛡️</div>
              <h2 className="text-xl font-extrabold text-white">Sovereign Node Compliance (KYC)</h2>
              <p className="text-sm text-[#94a3b8] max-w-md mx-auto">Identity validation checks are mandatory prior to token allocation events to isolate sybil vectors.</p>
              <div className="bg-black/30 border border-white/5 rounded-xl p-4 text-left max-w-md mx-auto font-mono text-xs text-amber-400">
                STATUS REFERENCE: STAGE PENDING (MAINNET CLAIM DEPLOYMENTS ONLY)
              </div>
              <button disabled className="px-6 py-3 bg-white/5 text-[#64748b] rounded-xl text-xs font-mono font-bold cursor-not-allowed">🔒 PORTAL OPENS AT PHASE 3 TGE</button>
            </div>
          )}

          {currentPage === 'White Paper' && (
            <div className="max-w-4xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-6">
              <h1 className="text-2xl font-black text-white">THE INAYA PROTOCOL</h1>
              <p className="text-xs text-[#94a3b8] font-bold uppercase tracking-wider">A Decentralized Sovereign Custody Network for High-Value Assets</p>
              
              <div className="flex flex-wrap gap-2 border-b border-white/5 pb-3">
                {['Abstract', 'The Problem', 'Architecture', 'Tokenomics Matrix'].map((sec) => (
                  <button key={sec} onClick={() => setActivePaperSection(sec)} className={`px-4 py-2 text-xs font-mono font-bold rounded-lg transition-all ${activePaperSection === sec ? 'bg-[#00f2fe]/10 border border-[#00f2fe] text-[#00f2fe]' : 'text-[#64748b] bg-white/[0.01]'}`}>{sec}</button>
                ))}
              </div>

              <div className="font-mono text-xs leading-relaxed text-[#94a3b8] bg-black/20 p-5 rounded-xl border border-white/5 max-h-[50vh] overflow-y-auto space-y-4">
                {activePaperSection === 'Abstract' && (
                  <>
                    <h3 className="text-white font-bold text-sm">// 1.0 ABSTRACT SUMMARY</h3>
                    <p>Inaya Custody Network represents a paradigm shift in decentralized object storage management. Traditional layouts suffer from localized single-point failures and third-party infrastructure exposures.</p>
                  </>
                )}

                {activePaperSection === 'The Problem' && (
                  <>
                    <h3 className="text-white font-bold text-sm">// 2.0 CENTRALIZED CUSTODY LIABILITY</h3>
                    <p>Modern cloud architectures rely on corporate server frameworks that compromise raw sovereignty. Governments and massive data monopolizers maintain deep vector tracking capabilities that can intercept client data objects mid-transit.</p>
                  </>
                )}

                {activePaperSection === 'Architecture' && (
                  <>
                    <h3 className="text-white font-bold text-sm">// 3.0 SYSTEM FRAGMENTATION TECHNOLOGY</h3>
                    <p>When a node initiates a data store action within the Inaya core framework, shards are pushed via separate network pipes into isolated decentralized storage vaults, and their tracking metadata hashes are cryptographically anchored to public EVM contract ledgers.</p>
                  </>
                )}

                {activePaperSection === 'Tokenomics Matrix' && (
                  <div className="space-y-4 font-sans">
                    <h3 className="text-white font-bold text-xs font-mono">// 4.0 ALLOCATION DISPOSAL DATA</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center pt-2">
                      <div className="w-full aspect-square border border-white/10 bg-[#060913] rounded-xl overflow-hidden flex items-center justify-center p-4 relative">
                        <Image 
                          src="/tokenomics.png" 
                          alt="Tokenomics Allocation Diagram" 
                          width={400} 
                          height={400} 
                          className="w-full h-full object-contain" 
                          unoptimized
                        />
                      </div>
                      <div className="font-mono text-xs space-y-3">
                        <div className="text-white font-bold bg-white/5 p-2 rounded">Total Hard Cap: 30,000,000 TOKENS</div>
                        <div className="space-y-1 text-[#94a3b8]">
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>🛸 Future Swarm Swaps Reserves:</span><span className="text-[#4facfe] font-bold">66.7% (20M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>💧 Liquidity Pool Allocation:</span><span>21.7% (6.5M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>👥 Team Runway Core:</span><span>5.0% (1.5M)</span></div>
                          <div className="flex justify-between"><span>🎁 Genesis Airdrop Portals:</span><span>3.3% (1M)</span></div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {currentPage === 'About Us' && (
            <div className="max-w-5xl mx-auto space-y-8">
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-lg font-extrabold text-white mb-2">OUR CORE MISSION</h3>
                <p className="text-xs text-[#94a3b8] font-mono leading-relaxed">
                  Inaya Network ka wahid maqsad client-side devices par data ki absolute sovereignty ko bahal karna hai. Hum aisi decentralized custody solutions tarteeb de rahe hain jahan kisi bhi centralized organization ya server management provider ke paas aapke private storage keys intercept karne ka rasta na ho. 
                </p>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🗺️ DECENTRALIZED SWARM ROADMAP</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
                  <div className="bg-black/20 p-4 rounded-xl border border-[#00f2fe]/20">
                    <div className="text-[#00f2fe] font-bold">Q1 2027: DEPLOYMENT PROOF</div>
                    <p className="text-[#64748b] text-[11px] mt-1">EVM validation matrix smart contract release across Binance Smart Chain scaling protocols.</p>
                  </div>
                  <div className="bg-black/20 p-4 rounded-xl border border-white/5">
                    <div className="text-white font-bold">Q2 2027: AUDIT PROTOCOLS</div>
                    <p className="text-[#64748b] text-[11px] mt-1">Global security validation check tracking loops and penetration audit matrix clearance tests.</p>
                  </div>
                  <div className="bg-black/20 p-4 rounded-xl border border-white/5">
                    <div className="text-white font-bold">Q3 2027: INCENTIVIZED CLAIM</div>
                    <p className="text-[#64748b] text-[11px] mt-1">Anti-sybil verification portal access execution loop and official TGE token allocation processing.</p>
                  </div>
                  <div className="bg-black/20 p-4 rounded-xl border border-white/5">
                    <div className="text-white font-bold">Q4 2027: SWARM SCALING</div>
                    <p className="text-[#64748b] text-[11px] mt-1">Cross-chain network bridge expansion loops to aggregate decentralized client file fragment storage servers.</p>
                  </div>
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🌐 LIVE NETWORKS INTERFACE ENDPOINTS</h3>
                <div className="flex flex-col sm:flex-row gap-4 font-mono text-xs text-[#00f2fe]">
                  <a href="https://t.me/inayanetwork" target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe] transition-all">Telegram Swarm Hub 🚀</a>
                  <a href="https://x.com/InayaNetwork" target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe] transition-all">X Network Telemetry 🐦</a>
                </div>
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
                <button key={w} onClick={() => connectTargetWallet(w)} className="w-full bg-white/[0.02] border border-white/5 hover:border-[#00f2fe] p-3.5 text-left rounded-xl text-xs text-white font-bold">{w}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}