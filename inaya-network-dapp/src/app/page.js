"use client";
import { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import Image from 'next/image';
import { buildProofOfStoragePayload } from '../lib/merkle'; // adjust path if lib/merkle.js lives elsewhere in your project

export default function Home() {
  // ========================================================
  // 1. SYSTEM ROUTING & CONTROL STATES
  // ========================================================
  const [currentPage, setCurrentPage] = useState('Network Home');
  const [activePaperSection, setActivePaperSection] = useState('Abstract');
  
  // ========================================================
  // 2. WEB3 WALLET PROVIDER ENGINE STATES
  // ========================================================
  const [walletAddress, setWalletAddress] = useState('');
  const [walletBalance, setWalletBalance] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isWalletModalOpen, setIsWalletModalOpen] = useState(false);
  const [selectedWalletName, setSelectedWalletName] = useState('');
  const [isWrongNetwork, setIsWrongNetwork] = useState(false);
  
  // ========================================================
  // 3. CRYPTOGRAPHIC SIGNATURE & IDENTITY SIGNUP STATES
  // ========================================================
  const [isSignedUp, setIsSignedUp] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  
  // ========================================================
  // 4. SHARDED STORAGE ENGINE CONFIGURATIONS
  // ========================================================
  const [assetId, setAssetId] = useState('');
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [masterPasskey, setMasterPasskey] = useState('');
  const [queryAssetId, setQueryAssetId] = useState('');

  // ========================================================
  // 🌳 PROOF-OF-STORAGE LOOKUP PANEL STATE
  // ========================================================
  const [proofLookupInput, setProofLookupInput] = useState('');
  const [proofLookupResult, setProofLookupResult] = useState(null);
  const [isLoadingProofLookup, setIsLoadingProofLookup] = useState(false);
  const [nodeLookupInput, setNodeLookupInput] = useState('');
  const [nodeLookupResult, setNodeLookupResult] = useState(null);
  const [isLoadingNodeLookup, setIsLoadingNodeLookup] = useState(false);

  // ========================================================
  // 🥩 $INAYA STAKING ENGINE STATE
  // ========================================================
  const [stakeAmountInput, setStakeAmountInput] = useState('');
  const [unstakeAmountInput, setUnstakeAmountInput] = useState('');
  const [selectedLockTier, setSelectedLockTier] = useState(0); // 0, 30, or 90
  const [stakingOverview, setStakingOverview] = useState({
    totalStakedTVL: '0',
    estimatedAPY: '0',
    myStakedBalance: '0',
    claimableRewards: '0',
    lockExpiryTimestamp: 0,
    userTier: 'None'
  });
  const [isStakingBusy, setIsStakingBusy] = useState(false);
  const [isUnstakingBusy, setIsUnstakingBusy] = useState(false);
  const [isClaimingBusy, setIsClaimingBusy] = useState(false);
  const [stakingLog, setStakingLog] = useState('');
  const stakingActionLockRef = useRef(false);
  
  // ========================================================
  // 5. DECENTRALIZED IDENTITY POINTS DATA MATRIX
  // ========================================================
  const [userPoints, setUserPoints] = useState({ dapp_points: 0, social_points: 0, total_points: 0 });
  const [socialHandle, setSocialHandle] = useState('');
  
  // ========================================================
  // 6. ON-CHAIN EVM EVENT HISTORY REGISTERS
  // ========================================================
  const [vaultHistory, setVaultHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [faucetLog, setFaucetLog] = useState('');
  const [isFauceting, setIsFauceting] = useState(false);
  
  // ========================================================
  // 7. BROADCAST TELEMETRY & CONSOLE LOGGERS
  // ========================================================
  const [statusLog, setStatusLog] = useState('');
  const [txHashLink, setTxHashLink] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [restoredName, setRestoredName] = useState('');
  const [copiedField, setCopiedField] = useState('');
  const fileInputRef = useRef(null);

  // Dynamic Cost States for Frontend Math
  const [dynamicInayaCost, setDynamicInayaCost] = useState("0.00");
  const [dynamicUsdtCost, setDynamicUsdtCost] = useState("0.00");

  // Feature states: balance check, progress tracker, asset ID history, success summary
  const [userInayaBalance, setUserInayaBalance] = useState(0n);
  const [userUsdtBalance, setUserUsdtBalance] = useState(0n);
  const [requiredInayaWei, setRequiredInayaWei] = useState(0n);
  const [requiredUsdtWei, setRequiredUsdtWei] = useState(0n);
  const [uploadProgress, setUploadProgress] = useState([]);
  const [assetIdHistory, setAssetIdHistory] = useState([]);
  const [showAssetIdDropdown, setShowAssetIdDropdown] = useState(false);
  const [lastBatchResults, setLastBatchResults] = useState([]);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isProcessingInvoice, setIsProcessingInvoice] = useState(false);
  const corporateCheckoutLockRef = useRef(false); // hard lock — blocks double-submit / double-click duplication

  // ========================================================
  // 💵 PAY-AS-YOU-GO (PAYG) DASHBOARD & BILLING STATE
  // ========================================================
  const [paygTbUnits, setPaygTbUnits] = useState(1);
  const [paygEgressUnits, setPaygEgressUnits] = useState(1);
  const [paygStatus, setPaygStatus] = useState({ tbCommitted: 0, storagePaidThrough: 0, lastMaintenancePaidAt: 0, storageActive: false, maintenanceCurrent: false });
  const [paygPricing, setPaygPricing] = useState({ storagePerTB: "4.5", egressPerHalfTB: "5", maintenanceFee: "5" });
  const [paygHistory, setPaygHistory] = useState([]);
  const [paygLog, setPaygLog] = useState('');
  const [isPaygStorageBusy, setIsPaygStorageBusy] = useState(false);
  const [isPaygEgressBusy, setIsPaygEgressBusy] = useState(false);
  const [isPaygMaintenanceBusy, setIsPaygMaintenanceBusy] = useState(false);
  const [isLoadingPaygHistory, setIsLoadingPaygHistory] = useState(false);
  const paygActionLockRef = useRef(false); // shared lock across the three PAYG actions

  // 💎 CORPORATE RESERVE (ANNUAL) SUBSCRIPTION SUBSYSTEM STATE
  const [selectedB2BTier, setSelectedB2BTier] = useState('250 TB / Year');
  const [b2bTierData, setB2BTierData] = useState({
    price: "13,500 USDT / Year",
    maintenance: "500 USDT-equivalent INAYA / Year",
    inclusions: "Corporate Reserve allocation billed annually in USDT; baseline storage locked at the 4.5 USDT/TB/month rate",
    maxFileMB: 262144000, 
    maxTotalMB: 262144000,
    displayLimit: "250 TB Annual Allocation"
  });

  const [activeCorporatePlan, setActiveCorporatePlan] = useState(null);

  // Dynamic Tier Allocation Listeners — Corporate Reserve (Annual) Plans
  useEffect(() => {
    if (selectedB2BTier === '250 TB / Year') {
      setB2BTierData({ price: "13,500 USDT / Year", maintenance: "500 USDT-equivalent INAYA / Year", inclusions: "Corporate Reserve allocation billed annually in USDT; baseline storage locked at the 4.5 USDT/TB/month rate", maxFileMB: 262144000, maxTotalMB: 262144000, displayLimit: "250 TB Annual Allocation" });
    } else if (selectedB2BTier === '500 TB / Year') {
      setB2BTierData({ price: "27,000 USDT / Year", maintenance: "1,000 USDT-equivalent INAYA / Year", inclusions: "Corporate Reserve allocation billed annually in USDT; priority distributed routing", maxFileMB: 524288000, maxTotalMB: 524288000, displayLimit: "500 TB Annual Allocation" });
    } else if (selectedB2BTier === '1000 TB / Year') {
      setB2BTierData({ price: "54,000 USDT / Year", maintenance: "2,000 USDT-equivalent INAYA / Year", inclusions: "Corporate Reserve allocation billed annually in USDT; dedicated RPC endpoints, zero-latency SLAs", maxFileMB: 1048576000, maxTotalMB: 1048576000, displayLimit: "1000 TB Annual Allocation" });
    }
  }, [selectedB2BTier]);

  // Fixed Network Endpoint Registries
  const liveContractAddress = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888"; 
  const usdtTokenAddress = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D"; 
  const inayaTokenAddress = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e"; 
  const nodeRegistryAddress = process.env.NEXT_PUBLIC_NODE_REGISTRY_ADDRESS || "0x61df4aEb4a5CeeB0D1192B8caE2b3936badd3d15";
  const revenueRouterAddress = process.env.NEXT_PUBLIC_REVENUE_ROUTER_ADDRESS || "0x76B0d41f5c02b34FEa36E5F23D3D3d34C7243256";

  // ABI Updated for dynamic sizes array and perGB fee logic
  const contractABI = [
    "function batchRegisterAssets(bytes32[] fileHashes, uint256[] fileSizes, string[] shardACIDs, string[] shardBCIDs) external",
    "function assets(bytes32) public view returns (address owner, string shardACID, string shardBCID, uint256 timestamp)",
    "function usdtFeePerGB() public view returns (uint256)",
    "function inayaFeePerGB() public view returns (uint256)",
    "function usdtToken() public view returns (address)",
    "function inayaToken() public view returns (address)",
    "event AssetRegistered(address indexed owner, bytes32 indexed fileHash, string shardACID, string shardBCID, uint256 timestamp)"
  ];

  const erc20ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function allowance(address owner, address spender) public view returns (uint256)",
    "function balanceOf(address account) public view returns (uint256)",
    "function decimals() public view returns (uint8)"
  ];

  // ========================================================
  // 🧾 PROOF-OF-STORAGE REGISTRY — InayaProofRegistry.sol
  // ========================================================
  // registerMerkleRoot has no onlyOwner guard, so the connected user's wallet can call it directly.
  // verifyChunkProof IS onlyOwner (only the contract deployer's key can call it) — it is intentionally
  // NOT wired into this client-side UI. That call belongs in a backend/verifier process, exactly like
  // scripts/verify-chunk.js already does with a server-held private key.
  const proofRegistryAddress = "0xbd36fF32293414F7DA320c095b6324f64C86345C";
  const proofRegistryABI = [
    "function registerMerkleRoot(bytes32 _fileHash, bytes32 _merkleRoot, uint256 _chunkCount, address _node) external",
    "function verifyChunkProof(bytes32 _fileHash, uint256 _leafIndex, bytes32 _leaf, bytes32[] calldata _proof) external returns (bool)",
    "function getNodeReliability(address _node) external view returns (uint256 passed, uint256 failed)",
    "function getAssetProof(bytes32 _fileHash) external view returns (tuple(bytes32 merkleRoot, uint256 chunkCount, address owner, address node, uint256 registeredAt, uint256 lastVerifiedAt, uint256 challengesPassed, uint256 challengesFailed))",
    "function assetProofs(bytes32) public view returns (bytes32 merkleRoot, uint256 chunkCount, address owner, address node, uint256 registeredAt, uint256 lastVerifiedAt, uint256 challengesPassed, uint256 challengesFailed)",
    "function nodePassCount(address) public view returns (uint256)",
    "function nodeFailCount(address) public view returns (uint256)",
    "event MerkleRootRegistered(bytes32 indexed fileHash, bytes32 merkleRoot, uint256 chunkCount, address indexed owner, address indexed node)",
    "event ProofVerified(bytes32 indexed fileHash, uint256 leafIndex, bool success, address indexed node)"
  ];

  // ========================================================
  // 💵 PAY-AS-YOU-GO (PAYG) BILLING CONTRACT — INAYA-SOW-PAYG-2026-V1
  // ========================================================
  const paygContractAddress = "0x22D543B02FdAA38635F859F27A6a636731936348";
  const paygABI = [
    "function paySubscriptionStorage(uint256 _tbUnits) external",
    "function payEgressFee(uint256 _halfTbUnits) external",
    "function payAnnualMaintenance() external",
    "function storagePricePerTB() public view returns (uint256)",
    "function egressPricePerHalfTB() public view returns (uint256)",
    "function annualMaintenanceFee() public view returns (uint256)",
    "function getSubscriptionStatus(address _user) external view returns (uint256 tbCommitted, uint256 storagePaidThrough, uint256 lastMaintenancePaidAt, bool storageActive, bool maintenanceCurrent)",
    "event StorageSubscriptionPaid(address indexed user, uint256 tbUnits, uint256 amountPaid, uint256 paidThrough)",
    "event EgressFeePaid(address indexed user, uint256 halfTbUnits, uint256 amountPaid, uint256 timestamp)",
    "event AnnualMaintenancePaid(address indexed user, uint256 amountPaid, uint256 nextDueAt)"
  ];

  // ========================================================
  // ESCROW CONTRACT CONSTANTS
  // ========================================================
  const corporateEscrowAddress = "0xadf0Be67889394065987467a8b6225BBf9DdfeEb";
  const corporateEscrowABI = [
    "function createEscrow(address _corporate, address _node, uint256 _totalAmount) external returns (uint256 scheduleId)",
    "event EscrowCreated(uint256 indexed scheduleId, address indexed corporate, address indexed node, uint256 totalAmount, uint256 monthlyAmount)"
  ];
  const OPERATOR_POOL_ADDRESS = "0x618f429bF27Ef458B60c1211b9ca8b3CD5d9C175";

  // ========================================================
  // 🥩 $INAYA STAKING ENGINE — InayaStaking.sol
  // ========================================================
  const stakingContractAddress = process.env.NEXT_PUBLIC_STAKING_ADDRESS || "0xc465279444Cb0E10c69D0769CDae31E457eA660f";
  const stakingABI = [
    "function stake(uint256 amount, uint256 lockPeriodDays) external",
    "function withdraw(uint256 amount) external",
    "function claimReward() external",
    "function exit() external",
    "function earned(address account) public view returns (uint256)",
    "function getUserTier(address account) external view returns (string memory)",
    "function totalStaked() public view returns (uint256)",
    "function rewardRate() public view returns (uint256)",
    "function userStakedBalance(address) public view returns (uint256)",
    "function lockExpiry(address) public view returns (uint256)",
    "function enterpriseTierThreshold() public view returns (uint256)",
    "event Staked(address indexed user, uint256 amount, uint256 lockPeriodDays)",
    "event Withdrawn(address indexed user, uint256 amount)",
    "event RewardPaid(address indexed user, uint256 reward)"
  ];

  // ========================================================
  // 🌐 NETWORK AUTO-SWITCH — BNB Chain Testnet
  // ========================================================
  const BSC_TESTNET_CHAIN_ID = '0x61'; 
  const BSC_TESTNET_PARAMS = {
    chainId: BSC_TESTNET_CHAIN_ID,
    chainName: 'BNB Smart Chain Testnet',
    nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
    rpcUrls: ['https://rpc.ankr.com/bsc_testnet', 'https://data-seed-prebsc-1-s1.binance.org:8545/'],
    blockExplorerUrls: ['https://testnet.bscscan.com']
  };

  const ensureCorrectNetwork = async () => {
    try {
      if (typeof window === 'undefined' || !window.ethereum) return false;
      const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
      if (currentChainId.toLowerCase() === BSC_TESTNET_CHAIN_ID) return true;

      setStatusLog("🔄 Switching network to BNB Chain Testnet...");
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: BSC_TESTNET_CHAIN_ID }]
        });
      } catch (switchErr) {
        if (switchErr.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [BSC_TESTNET_PARAMS]
          });
        } else {
          throw switchErr;
        }
      }
      return true;
    } catch (err) {
      console.error("Network switch failed:", err);
      setStatusLog(`❌ Please switch your wallet to BNB Chain Testnet manually: ${err.message}`);
      return false;
    }
  };

  // ========================================================
  // 📚 OFFICIAL DOCUMENTS & RESOURCES REGISTRY
  // ========================================================
  const documentsList = [
    { title: "The Inaya Protocol — Whitepaper", desc: "Technical & economic whitepaper covering the custody architecture and tokenomics.", href: "/documents/inaya-whitepaper.pdf", icon: "📄" },
    { title: "Strategic Business Model & Financial Architecture", desc: "Pay-as-you-go pricing, Corporate Reserve plans, TVL engine, and the verified token allocation matrix.", href: "/documents/inaya-business-model.pdf", icon: "📊" },
    { title: "The Node Operator Manifesto", desc: "Commission tiers, uptime requirements, and onboarding steps for hardware/storage node operators.", href: "/documents/inaya-operator-manifesto.pdf", icon: "🖥️" },
    { title: "Institutional & Enterprise FAQs", desc: "Compliance-oriented FAQ prepared for institutional and enterprise reviewers.", href: "/documents/inaya-institutional-faqs.pdf", icon: "🏛️" },
    { title: "General User & Community FAQs", desc: "Plain-language FAQ for everyday users, builders, and grant applicants.", href: "/documents/inaya-community-faqs.pdf", icon: "💬" },
    { title: "Inaya Custody SDK — Developer Guide", desc: "Integration guide and API reference for @inaya-network/custody-sdk.", href: "/documents/inaya-sdk-guide.pdf", icon: "🛠️" },
    { title: "Inaya Protocol — Technical SOW", desc: "DePIN custody layer scope of work: component deliverables, architecture boundaries, and system data flow for auditors and engineering teams.", href: "/documents/inaya-technical-sow.pdf", icon: "🧩" },
    { title: "Inaya Network — Company Profile", desc: "Official corporate profile covering the executive summary, core architecture, leadership team, and strategic roadmap.", href: "/documents/inaya-company-profile.pdf", icon: "🏢" },
  ];

  const copyToClipboard = async (text, fieldKey) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldKey);
      setTimeout(() => setCopiedField(''), 1800);
    } catch (err) {
      console.error("Clipboard write failed:", err);
    }
  };

  const truncateAddress = (addr) => `${addr.slice(0, 8)}...${addr.slice(-6)}`;

  const splitFileName = (name) => {
    const lastDot = name.lastIndexOf('.');
    if (lastDot <= 0) return { base: name, ext: '—' };
    return { base: name.slice(0, lastDot), ext: name.slice(lastDot + 1).toUpperCase() };
  };

  const getFileIcon = (filename) => {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const map = {
      pdf: '📕', doc: '📃', docx: '📃', txt: '📄', md: '📄',
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
      zip: '🗜️', rar: '🗜️', '7z': '🗜️',
      mp4: '🎞️', mov: '🎞️', avi: '🎞️', mkv: '🎞️',
      mp3: '🎵', wav: '🎵',
      csv: '📊', xlsx: '📊', xls: '📊',
      json: '🧾', xml: '🧾',
    };
    return map[ext] || '📁';
  };

  // ========================================================
  // 🗂️ LOCAL FILENAME REGISTRY
  // ========================================================
  const FILENAME_STORAGE_KEY = 'inaya_filename_registry';

  const saveFilenameMapping = (hash, filename) => {
    try {
      const existing = JSON.parse(localStorage.getItem(FILENAME_STORAGE_KEY) || '{}');
      existing[hash] = filename;
      localStorage.setItem(FILENAME_STORAGE_KEY, JSON.stringify(existing));
    } catch (err) {
      console.error("Local filename registry write failed:", err);
    }
  };

  const getFilenameMapping = (hash) => {
    try {
      const existing = JSON.parse(localStorage.getItem(FILENAME_STORAGE_KEY) || '{}');
      return existing[hash] || null;
    } catch (err) {
      return null;
    }
  };

  // ========================================================
  // 🧠 ASSET ID HISTORY
  // ========================================================
  const ASSET_ID_HISTORY_KEY = 'inaya_asset_id_history';

  const saveAssetIdHistory = (assetIdText, hash, filename) => {
    try {
      const existing = JSON.parse(localStorage.getItem(ASSET_ID_HISTORY_KEY) || '[]');
      const updated = [{ assetIdText, hash, filename, timestamp: Date.now() }, ...existing];
      const deduped = updated.filter((item, idx, arr) => arr.findIndex(i => i.assetIdText === item.assetIdText) === idx);
      localStorage.setItem(ASSET_ID_HISTORY_KEY, JSON.stringify(deduped.slice(0, 50)));
    } catch (err) {
      console.error("Asset ID history write failed:", err);
    }
  };

  const getAssetIdHistory = () => {
    try {
      return JSON.parse(localStorage.getItem(ASSET_ID_HISTORY_KEY) || '[]');
    } catch (err) {
      return [];
    }
  };

  const computeFileHash = (assetIdText) => ethers.keccak256(ethers.toUtf8Bytes(assetIdText));

  // ========================================================
  // 🌳 MERKLE TREE LAYER CACHE (per-file, for later chunk challenges)
  // ========================================================
  // Only the Merkle ROOT goes on-chain (via registerMerkleRoot). The full layers are needed later
  // to produce a proof for a given leafIndex — that reconstruction should ultimately live in your
  // backend/DB (see scripts/verify-chunk.js's asset-store.json), not just the browser. Caching here
  // is a stopgap so the data isn't lost immediately after upload; it will not survive a cleared
  // browser or a different device.
  const MERKLE_TREE_KEY = 'inaya_merkle_tree_cache';

  const saveMerkleTreeRecord = (fileHash, { layers, chunkCount, root }) => {
    try {
      const existing = JSON.parse(localStorage.getItem(MERKLE_TREE_KEY) || '{}');
      existing[fileHash] = { layers, chunkCount, root, savedAt: Date.now() };
      localStorage.setItem(MERKLE_TREE_KEY, JSON.stringify(existing));
    } catch (err) {
      console.error("Merkle tree cache write failed:", err);
    }
  };

  const getMerkleTreeRecord = (fileHash) => {
    try {
      const existing = JSON.parse(localStorage.getItem(MERKLE_TREE_KEY) || '{}');
      return existing[fileHash] || null;
    } catch (err) {
      return null;
    }
  };

  // ========================================================
  // 🧾 CORPORATE RESERVE — ACTIVE PLAN REGISTRY (DUPLICATE-PURCHASE GUARD)
  // ========================================================
  const CORPORATE_ACTIVE_KEY = 'inaya_corporate_active_plans';
  const CORPORATE_TERM_MS = 365 * 24 * 60 * 60 * 1000; // 1 year, mirrors the on-chain annual billing cycle

  const getActiveCorporatePlan = (address) => {
    try {
      const registry = JSON.parse(localStorage.getItem(CORPORATE_ACTIVE_KEY) || '{}');
      const entry = registry[address.toLowerCase()];
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) return null; // term lapsed, no longer "active"
      return entry;
    } catch (err) {
      return null;
    }
  };

  const saveActiveCorporatePlan = (address, tier, txHash) => {
    try {
      const registry = JSON.parse(localStorage.getItem(CORPORATE_ACTIVE_KEY) || '{}');
      const now = Date.now();
      registry[address.toLowerCase()] = { tier, txHash, activatedAt: now, expiresAt: now + CORPORATE_TERM_MS };
      localStorage.setItem(CORPORATE_ACTIVE_KEY, JSON.stringify(registry));
    } catch (err) {
      console.error("Corporate plan registry write failed:", err);
    }
  };

  // ========================================================
  // REAL-TIME COST CALCULATOR + BALANCE SUFFICIENCY CHECK
  // ========================================================
  useEffect(() => {
    if (selectedFiles.length === 0) {
      setDynamicInayaCost("0.00");
      setDynamicUsdtCost("0.00");
      setRequiredInayaWei(0n);
      setRequiredUsdtWei(0n);
      return;
    }
    const ONE_GB_IN_BYTES = 1024 * 1024 * 1024;
    const totalBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);
    const calculatedFee = (totalBytes / ONE_GB_IN_BYTES) * 0.1;
    const displayFee = calculatedFee > 0 ? calculatedFee.toFixed(6) : "0.00";

    setDynamicInayaCost(displayFee);
    setDynamicUsdtCost(displayFee);

    const checkBalances = async () => {
      try {
        if (typeof window === 'undefined' || !window.ethereum || !walletAddress) return;
        const provider = new ethers.BrowserProvider(window.ethereum);
        const custody = new ethers.Contract(liveContractAddress, contractABI, provider);
        const inayaToken = new ethers.Contract(inayaTokenAddress, erc20ABI, provider);
        const usdtToken = new ethers.Contract(usdtTokenAddress, erc20ABI, provider);

        let usdtFeePerGB = 100000000000000000n; 
        let inayaFeePerGB = 100000000000000000n;
        let inayaBal = 0n;
        let usdtBal = 0n;

        try {
          const [fUsdt, fInaya, bInaya, bUsdt] = await Promise.all([
            custody.usdtFeePerGB(),
            custody.inayaFeePerGB(),
            inayaToken.balanceOf(walletAddress),
            usdtToken.balanceOf(walletAddress)
          ]);
          usdtFeePerGB = fUsdt;
          inayaFeePerGB = fInaya;
          inayaBal = bInaya;
          usdtBal = bUsdt;
        } catch (rpcErr) {
          console.warn("Soft view fallback inside balance ticker triggered:", rpcErr);
        }

        let totalUsdtFeeWei = 0n;
        let totalInayaFeeWei = 0n;
        selectedFiles.forEach((f) => {
          totalUsdtFeeWei += (BigInt(f.size) * usdtFeePerGB) / 1073741824n;
          totalInayaFeeWei += (BigInt(f.size) * inayaFeePerGB) / 1073741824n;
        });

        setRequiredInayaWei(totalInayaFeeWei);
        setRequiredUsdtWei(totalUsdtFeeWei);
        setUserInayaBalance(inayaBal);
        setUserUsdtBalance(usdtBal);
      } catch (err) {
        console.error("Balance calculation pipeline error:", err);
      }
    };
    checkBalances();
  }, [selectedFiles, walletAddress]);

  useEffect(() => {
    setAssetIdHistory(getAssetIdHistory());
  }, []);

  // ========================================================
  // 📲 BACKEND TELEMETRY CORE SYNC METHODS
  // ========================================================
  const fetchUserPoints = async (address) => {
    try {
      const res = await fetch(`/api/points?address=${address.toLowerCase()}`);
      if (res.ok) {
        const data = await res.json();
        setUserPoints({ dapp_points: data.dapp_points || 0, social_points: data.social_points || 0, total_points: data.total_points || 0 });
      }
    } catch (err) { 
      console.error("Points server sync error:", err); 
    }
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

        const onCorrectNetwork = await ensureCorrectNetwork();
        if (!onCorrectNetwork) {
          setStatusLog("⚠️ Wallet connected, but not on BNB Chain Testnet. Please switch networks to use the Vault.");
        }

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
    if (!isConnected || !walletAddress) { alert("Authentication error: Connect wallet first."); return; }
    setIsSigning(true);
    setStatusLog("🔐 Emitting unique cryptographic host registration message to your wallet provider...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const verificationMessage = `[INAYA CUSTODY NETWORK - NODE REGISTRATION]\n\nAuthorize client-side encrypted data fragmentation access routines for this host station.\n\nNode Index: ${walletAddress.toLowerCase()}\nTimestamp Hash: ${Date.now()}`;
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
      alert(`❌ Sign-up failed: ${err.message}`);
    } finally {
      setIsSigning(false);
    }
  };

  // ========================================================
  // 💳 B2B CORPORATE INVOICE CHECKOUT LOOP
  // ========================================================
  const handleCorporateCheckout = async () => {
    if (!isConnected || !walletAddress) { 
      alert("🚨 Wallet Connected Nahi Hai! Pehle wallet connect karein."); 
      return; 
    }

    if (corporateCheckoutLockRef.current || isProcessingInvoice) {
      return;
    }

    const existingPlan = getActiveCorporatePlan(walletAddress);
    if (existingPlan) {
      const expiresLabel = new Date(existingPlan.expiresAt).toLocaleDateString();
      const proceed = window.confirm(
        `⚠️ You already have an active ${existingPlan.tier} Corporate Reserve plan (valid until ${expiresLabel}).\n\n` +
        `Purchasing ${selectedB2BTier} now will stack an additional billing cycle on-chain.\n\n` +
        `Continue anyway?`
      );
      if (!proceed) {
        setStatusLog(`ℹ️ Checkout cancelled: ${existingPlan.tier} plan is already active until ${expiresLabel}.`);
        return;
      }
    }

    corporateCheckoutLockRef.current = true;
    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { 
      alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); 
      corporateCheckoutLockRef.current = false;
      return; 
    }

    setIsProcessingInvoice(true);
    setStatusLog("🔄 Corporate checkout pipeline initiated...");

    if (!revenueRouterAddress || !usdtTokenAddress) {
      alert("❌ Environment Error: Router or USDT addresses missing configuration.");
      setIsProcessingInvoice(false);
      corporateCheckoutLockRef.current = false;
      return;
    }

    let rawPrice = "13500"; 
    if (selectedB2BTier === '500 TB / Year') rawPrice = "27000";
    if (selectedB2BTier === '1000 TB / Year') rawPrice = "54000";

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const usdtContract = new ethers.Contract(usdtTokenAddress, erc20ABI, signer);

      const usdtDecimals = await usdtContract.decimals();
      const invoiceAmountWei = ethers.parseUnits(rawPrice, usdtDecimals);

      setStatusLog("🔍 Verifying mUSDT balance covers this invoice...");
      const currentBalance = await usdtContract.balanceOf(walletAddress);
      if (currentBalance < invoiceAmountWei) {
        const have = ethers.formatUnits(currentBalance, usdtDecimals);
        const need = ethers.formatUnits(invoiceAmountWei, usdtDecimals);
        alert(`🚨 Insufficient mUSDT Balance!\n\nYou have ${have} mUSDT.\nThis plan requires ${need} mUSDT.\n\nUse the Faucet tab to request more test tokens.`);
        setStatusLog(`❌ Blocked before signing: balance ${have} mUSDT < required ${need} mUSDT.`);
        setIsProcessingInvoice(false);
        corporateCheckoutLockRef.current = false;
        return;
      }

      setStatusLog(`🔍 Checking USDT allowance for Router...`);
      const currentAllowance = await usdtContract.allowance(walletAddress, revenueRouterAddress);

      if (currentAllowance < invoiceAmountWei) {
        setStatusLog(`✍️ Requesting USDT spending approval for ${rawPrice} mUSDT...`);
        const approveTx = await usdtContract.approve(revenueRouterAddress, ethers.MaxUint256);
        setStatusLog("⏳ Mining approval transaction...");
        await approveTx.wait();
        setStatusLog("✅ USDT approved successfully!");
      }

      const routerABI = ["function processCorporateInvoice(uint256 _usdtAmount) external"];
      const routerContract = new ethers.Contract(revenueRouterAddress, routerABI, signer);

      setStatusLog(`✍️ Signing invoice settlement for ${selectedB2BTier} package...`);
      const checkoutTx = await routerContract.processCorporateInvoice(invoiceAmountWei);

      setStatusLog("⏳ Settling corporate revenue allocation loop on-chain...");
      await checkoutTx.wait();

      setTxHashLink(`https://testnet.bscscan.com/tx/${checkoutTx.hash}`);
      setStatusLog(`🎯 CORPORATE TIER ACTIVE: 3-Way revenue splitting fully settled.`);

      // ============================================================
      // 🔒 ESCROW LOGIC START (39% COGS)
      // ============================================================
      setStatusLog("🔒 Escrowing node-operator commission for monthly release...");

      const cogsAmountWei = (invoiceAmountWei * 39n) / 100n;

      const escrowAllowance = await usdtContract.allowance(walletAddress, corporateEscrowAddress);
      if (escrowAllowance < cogsAmountWei) {
        setStatusLog("✍️ Requesting USDT approval for the escrow contract...");
        const approveEscrowTx = await usdtContract.approve(corporateEscrowAddress, ethers.MaxUint256);
        await approveEscrowTx.wait();
      }

      const escrowContract = new ethers.Contract(corporateEscrowAddress, corporateEscrowABI, signer);
      setStatusLog(`✍️ Creating 12-month escrow schedule for ${ethers.formatUnits(cogsAmountWei, usdtDecimals)} mUSDT...`);
      
      const escrowTx = await escrowContract.createEscrow(walletAddress, OPERATOR_POOL_ADDRESS, cogsAmountWei);
      await escrowTx.wait();

      setStatusLog(`✅ Escrow active: ${ethers.formatUnits(cogsAmountWei / 12n, usdtDecimals)} mUSDT/month for 12 months.`);
      // ============================================================
      // 🔓 ESCROW LOGIC END
      // ============================================================

      saveActiveCorporatePlan(walletAddress, selectedB2BTier, checkoutTx.hash);
      setActiveCorporatePlan(getActiveCorporatePlan(walletAddress));

      // ⚠️ ALERT SABSE AAKHIR MEIN AAYEGA
      alert(`🎉 Success! ${selectedB2BTier} plan status has been activated securely.`);

} catch (err) {
      console.error("Checkout crash:", err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      alert(`❌ Checkout Failed: ${friendly}`);
      setStatusLog(`❌ Pipeline Error: ${friendly}`);
    } finally {
      setIsProcessingInvoice(false);
      corporateCheckoutLockRef.current = false;
    }
  }; // <--- Yeh bracket handleCorporateCheckout ko close karne ke liye hai

  // ========================================================
  // 🛡️ BROWSER AES-GCM / PBKDF2 HARDENED SECURE MATRIX
  // ========================================================
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
    const enc = new TextEncoder(); const binaryStr = window.atob(base64Str);
    const combined = new Uint8Array(binaryStr.length); for (let i = 0; i < binaryStr.length; i++) { combined[i] = binaryStr.charCodeAt(i); }
    const salt = combined.slice(0, 16); const fontIv = combined.slice(16, 28); const encrypted = combined.slice(28);
    const keyMaterial = await window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"]);
    const key = await window.crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return enc.decode(await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: fontIv }, key, encrypted));
  };

  // ⚡ MONGO BUSINESS PIPELINE ROUTING FOR PINATA
  const uploadToPinata = async (encryptedShard, filename, elementTag) => {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        encryptedShard, 
        filename, 
        elementTag,
        walletAddress,
        selectedTier: selectedB2BTier
      })
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || "IPFS Pipeline drop failure.");
    return data.IpfsHash;
  };

  // ========================================================
  // ⚡ DISPERSAL & ASSEMBLY ROUTINES FOR ATOMIC DATASTORE
  // ========================================================
  const readFileAsDataURL = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const prepareShardedFile = async (file) => {
    const dataUrl = await readFileAsDataURL(file);
    const cipherTextString = await encryptData(dataUrl, masterPasskey);
    const midpoint = Math.ceil(cipherTextString.length / 2);

    const [cidA, cidB] = await Promise.all([
      uploadToPinata(cipherTextString.slice(0, midpoint), file.name, "Alpha"),
      uploadToPinata(cipherTextString.slice(midpoint), file.name, "Beta")
    ]);

    // 🌳 Proof-of-storage: chunk the same ciphertext into 256KB leaves and build the Merkle tree.
    // NOTE: this chunking is independent of the Alpha/Beta pinning above — verifyChunkProof's
    // eventual chunk-fetch step (see scripts/verify-chunk.js) expects a CID *per chunk*, which this
    // two-shard pipeline does not produce. Root registration below works today; wiring a real
    // end-to-end challenge later will require pinning each 256KB chunk individually too.
    const { root, layers, chunkCount } = buildProofOfStoragePayload(cipherTextString);

    return { filename: file.name, cidAlpha: cidA, cidBeta: cidB, merkleRoot: root, merkleLayers: layers, chunkCount };
  };

  const ensureTokenApproval = async (tokenAddress, signer, ownerAddress, requiredAmountWei, label) => {
    try {
      const token = new ethers.Contract(tokenAddress, erc20ABI, signer);
      const currentAllowance = await token.allowance(ownerAddress, liveContractAddress);
      if (currentAllowance >= requiredAmountWei) return;

      setStatusLog(`✍️ Requesting approval to spend ${label}...`);
      const approveTx = await token.approve(liveContractAddress, ethers.MaxUint256);
      await approveTx.wait();
      setStatusLog(`✅ ${label} spending approved!`);
    } catch (err) {
      console.warn(`Approval skipped or already authorized for ${label}:`, err);
    }
  };

  // ========================================================
  // UPLOAD SEQUENCE (ISOLATED VIEW CALLS & TYPO-CRUSHED)
  // ========================================================
  const handleUploadSequence = async () => {
    if (!isConnected) { alert("🚨 Wallet Connected Nahi Hai! Pehle top-right se wallet connect karein."); return; }
    
    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    if (!isSignedUp) { alert("🚨 Node Verified Nahi Hai! Sidebar mein 'COMPLETE SIGN UP (VERIFY NODE)' par click karke message sign karein."); return; }
    if (!assetId) { alert("🚨 Asset Tracking ID missing hai! Input field mein koi ID enter karein."); return; }
    if (selectedFiles.length === 0) { alert("🚨 Koi file select nahi ki! Pehle file attach karein."); return; }
    if (!masterPasskey) { alert("🚨 Master Node Passkey missing hai! Sidebar mein passkey enter karein."); return; }
    
    if (hasSizeViolation) {
      alert(`❌ Size limit violation: Your allocation limits allow up to ${b2bTierData.displayLimit} processing capacity under ${selectedB2BTier}.`);
      return;
    }

    setTxHashLink(''); setDownloadUrl(''); setLastBatchResults([]);
    const isBatch = selectedFiles.length > 1;
    const fileHashes = [];
    const fileSizes = [];
    const shardACIDs = [];
    const shardBCIDs = [];
    const pendingFilenameMappings = [];
    const pendingMerkleRecords = []; // { hash, root, chunkCount, layers } — registered on-chain after custody tx confirms

    const initialProgress = selectedFiles.map((f) => ({ filename: f.name, status: 'pending', message: 'Queued' }));
    setUploadProgress(initialProgress);

    const updateProgress = (index, status, message) => {
      setUploadProgress((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], status, message };
        return next;
      });
    };

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      const effectiveAssetId = isBatch ? `${assetId}-${i + 1}` : assetId;
      try {
        updateProgress(i, 'processing', 'Encrypting (PBKDF2 + AES-GCM)...');
        const { filename, cidAlpha, cidBeta, merkleRoot, merkleLayers, chunkCount } = await prepareShardedFile(file);
        const hash = computeFileHash(effectiveAssetId);

        fileHashes.push(hash);
        fileSizes.push(file.size);
        shardACIDs.push(cidAlpha);
        shardBCIDs.push(cidBeta);
        pendingFilenameMappings.push({ hash, filename, assetIdText: effectiveAssetId });
        pendingMerkleRecords.push({ hash, root: merkleRoot, chunkCount, layers: merkleLayers });
        updateProgress(i, 'sharded', 'Sharded & uploaded to IPFS — awaiting signature');
      } catch (prepErr) {
        console.error(prepErr);
        updateProgress(i, 'error', prepErr.message || 'Encryption/sharding failed');
        alert(`❌ Sharding Pipeline Error on file [${file.name}]: ${prepErr.message}`);
        return;
      }
    }

    if (fileHashes.length === 0) {
      setStatusLog("❌ No files were successfully prepared — nothing to register.");
      return;
    }

    let totalUsdtFeeWei = requiredUsdtWei;
    let totalInayaFeeWei = requiredInayaWei;

    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      
      const readCustody = new ethers.Contract(liveContractAddress, contractABI, provider);
      const custody = new ethers.Contract(liveContractAddress, contractABI, signer);

      setStatusLog("🔍 Pre-validating tracking logs and allocations...");
      
      try {
        for (let i = 0; i < fileHashes.length; i++) {
          const assetRecord = await readCustody.assets(fileHashes[i]);
          if (assetRecord && assetRecord[0] !== ethers.ZeroAddress) {
            alert(`🚨 DUPLICATE ASSET ID DETECTED!\n\nYe Tracking ID [${pendingFilenameMappings[i].assetIdText}] pehle se registered hai.`);
            setStatusLog("❌ Transaction cancelled: Duplicate Tracking ID mapping found on-chain.");
            fileHashes.forEach((_, idx) => updateProgress(idx, 'error', 'Duplicate tracking ID'));
            return;
          }
        }
      } catch (assetErr) {
        console.warn("Isolating asset view check exception (Forcing fallback bypass):", assetErr);
      }

      let usdtFeePerGB = 100000000000000000n; 
      let inayaFeePerGB = 100000000000000000n;
      try {
        const [fUsdt, fInaya] = await Promise.all([
          readCustody.usdtFeePerGB(),
          readCustody.inayaFeePerGB()
        ]);
        usdtFeePerGB = fUsdt;
        inayaFeePerGB = fInaya;
      } catch (feeErr) {
        console.warn("Using baseline configuration fees because view call failed:", feeErr);
      }

      let calculatedUsdtFee = 0n;
      let calculatedInayaFee = 0n;
      fileSizes.forEach((size) => {
        calculatedUsdtFee += (BigInt(size) * usdtFeePerGB) / 1073741824n;
        calculatedInayaFee += (BigInt(size) * inayaFeePerGB) / 1073741824n;
      });
      
      if (calculatedUsdtFee > 0n) totalUsdtFeeWei = calculatedUsdtFee;
      if (calculatedInayaFee > 0n) totalInayaFeeWei = calculatedInayaFee;

      if (totalUsdtFeeWei > 0n) {
        await ensureTokenApproval(usdtTokenAddress, signer, walletAddress, totalUsdtFeeWei, "Mock USDT");
      }
      if (totalInayaFeeWei > 0n) {
        await ensureTokenApproval(inayaTokenAddress, signer, walletAddress, totalInayaFeeWei, "$INAYA");
      }

      setStatusLog(`✍️ Requesting signature to register ${fileHashes.length} dynamic file(s) on-chain...`);
      fileHashes.forEach((_, idx) => updateProgress(idx, 'signing', 'Awaiting on-chain confirmation...'));

      let estimatedGas;
      try {
        estimatedGas = await custody.batchRegisterAssets.estimateGas(fileHashes, fileSizes, shardACIDs, shardBCIDs);
      } catch (gasErr) {
        console.warn("Gas simulation failed/skipped, setting safety bounds:", gasErr);
        estimatedGas = BigInt(360000) * BigInt(fileHashes.length);
      }

      const gasLimit = (estimatedGas * BigInt(130)) / BigInt(100);
      const tx = await custody.batchRegisterAssets(fileHashes, fileSizes, shardACIDs, shardBCIDs, { gasLimit });

      setStatusLog(`⏳ Mining dynamic batch transaction...`);
      await tx.wait();

      pendingFilenameMappings.forEach(({ hash, filename, assetIdText }) => {
        saveFilenameMapping(hash, filename);
        saveAssetIdHistory(assetIdText, hash, filename);
      });
      setAssetIdHistory(getAssetIdHistory());

      setLastBatchResults(pendingFilenameMappings.map(({ assetIdText, filename }) => ({ assetIdText, filename })));
      fileHashes.forEach((_, idx) => updateProgress(idx, 'done', 'Registered on-chain ✓'));

      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      setStatusLog(`🎯 DYNAMIC STATE SECURED: ${fileHashes.length} file(s) registered successfully.`);

      // --- Register each file's Merkle root on InayaProofRegistry ---
      // No batch function on this contract, so these go one-at-a-time. registerMerkleRoot has no
      // onlyOwner guard, so the same connected signer used for custody registration can call it.
      // A failure here does NOT roll back the custody registration above — the file is still
      // safely registered/stored either way, it just won't have a proof-of-storage root yet.
      setStatusLog(`✍️ Registering Merkle proof root(s) for ${pendingMerkleRecords.length} file(s)...`);
      const proofRegistry = new ethers.Contract(proofRegistryAddress, proofRegistryABI, signer);
      for (const { hash, root, chunkCount, layers } of pendingMerkleRecords) {
        try {
          const rootTx = await proofRegistry.registerMerkleRoot(hash, root, chunkCount, ethers.ZeroAddress);
          await rootTx.wait();
          saveMerkleTreeRecord(hash, { layers, chunkCount, root });
        } catch (rootErr) {
          console.error(`registerMerkleRoot failed for ${hash}:`, rootErr);
          setStatusLog(`⚠️ Custody registration succeeded, but Merkle root registration failed for one file: ${rootErr.reason || rootErr.message}`);
        }
      }
      setStatusLog(`🎯 DYNAMIC STATE SECURED: ${fileHashes.length} file(s) registered successfully (custody + proof root).`);

      setSelectedFiles([]);
    } catch (txErr) {
      console.error(txErr);
      fileHashes.forEach((_, idx) => updateProgress(idx, 'error', 'Transaction failed'));
      alert(`❌ Contract Interaction Failed: ${txErr.reason || txErr.message || txErr}`);
      if (txErr.code === 'ACTION_REJECTED') {
        setStatusLog("❌ Transaction cancelled: Signature rejected by host operator.");
      } else {
        setStatusLog(`❌ EVM Execution Crash: ${txErr.reason || txErr.message}`);
      }
      return;
    }

    try {
      await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'UPLOAD' })
      });
      fetchUserPoints(walletAddress);
      fetchOnChainHistory();
    } catch(apiErr) {
      console.error("Points calculation api failure:", apiErr);
    }
  };

  const handleRetrievalSequence = async (targetId) => {
    if (!isSignedUp) { alert("Access Denied: Authenticate node access array parameters first."); return; }
    const searchId = targetId || queryAssetId;
    if (!searchId || !masterPasskey) { alert("Input Error: Tracking index parameters missing."); return; }
    try {
      setTxHashLink(''); setDownloadUrl('');
      const searchHash = searchId.startsWith('0x') && searchId.length === 66 ? searchId : computeFileHash(searchId);
      setStatusLog(`🔍 Checking public blocks for tracking index reference #${searchHash.slice(0, 10)}...`);
      
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const record = await contract.assets(searchHash);
      const [ownerAddr, cidAlpha, cidBeta] = record;

      if (ownerAddr === ethers.ZeroAddress) {
        setStatusLog("❌ No registered asset found for that Asset Tracking ID.");
        return;
      }

      setStatusLog("🌐 Pulling synchronized multi-shard byte streams concurrently over edge proxies...");

      const fetchFastShard = async (cid) => {
        try {
          const res = await fetch(`https://cloudflare-ipfs.com/ipfs/${cid}`);
          const json = await res.json(); return json.shard;
        } catch {
          const res = await fetch(`https://gateway.pinata.cloud/ipfs/${cid}`);
          const json = await res.json(); return json.shard;
        }
      };

      const [shardA, shardB] = await Promise.all([
        fetchFastShard(cidAlpha),
        fetchFastShard(cidBeta)
      ]);

      const fullCipherText = shardA + shardB;
      const localFilename = getFilenameMapping(searchHash);
      setRestoredName(localFilename || searchId);
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

  const fetchOnChainHistory = async () => {
  if (!walletAddress) return;
  setIsLoadingHistory(true);
  try {
    // 1. Get local upload history first (Instant load)
    const localHistory = getAssetIdHistory().map(item => ({
      assetId: item.hash || computeFileHash(item.assetIdText),
      assetIdText: item.assetIdText,
      filename: item.filename,
      timestamp: item.timestamp || Date.now(),
      isLocal: true
    }));

    // 2. Fetch On-Chain logs as secondary sync
    let onChainHistory = [];
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const contract = new ethers.Contract(liveContractAddress, contractABI, provider);
      const latestBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, latestBlock - 2000); // Shorter range to prevent RPC error
      const filter = contract.filters.AssetRegistered();
      const logs = await contract.queryFilter(filter, fromBlock, 'latest');

      onChainHistory = logs.map(log => {
        if (!log.args) return null;
        const [op, hash, cA, cB] = log.args;
        if (op.toLowerCase() !== walletAddress.toLowerCase()) return null;
        const localFilename = getFilenameMapping(hash);
        return {
          assetId: hash,
          filename: localFilename || `${hash.slice(0, 10)}...${hash.slice(-6)}`,
          cidAlpha: cA,
          cidBeta: cB,
          operator: op,
          isLocal: false
        };
      }).filter(Boolean);
    } catch (rpcErr) {
      console.warn("RPC log query skipped/failed, using local registry:", rpcErr);
    }

    // Combine & Deduplicate by assetId
    const mergedMap = new Map();
    localHistory.forEach(item => mergedMap.set(item.assetId, item));
    onChainHistory.forEach(item => mergedMap.set(item.assetId, { ...mergedMap.get(item.assetId), ...item }));

    setVaultHistory(Array.from(mergedMap.values()).reverse());
  } catch (err) {
    console.error("History sync error:", err);
  } finally {
    setIsLoadingHistory(false);
  }
};

  // ========================================================
  // 💵 PAY-AS-YOU-GO (PAYG) — STATUS, PRICING & HISTORY SYNC
  // ========================================================
  const fetchPaygPricing = async (provider) => {
    try {
      const payg = new ethers.Contract(paygContractAddress, paygABI, provider);
      const [storagePrice, egressPrice, maintenanceFee] = await Promise.all([
        payg.storagePricePerTB(),
        payg.egressPricePerHalfTB(),
        payg.annualMaintenanceFee()
      ]);
      setPaygPricing({
        storagePerTB: ethers.formatUnits(storagePrice, 18),
        egressPerHalfTB: ethers.formatUnits(egressPrice, 18),
        maintenanceFee: ethers.formatUnits(maintenanceFee, 18)
      });
    } catch (err) {
      console.warn("PAYG pricing view call failed, using published defaults:", err);
    }
  };

  const fetchPaygStatus = async (address, providerOverride) => {
    if (!address) return;
    try {
      const provider = providerOverride || new ethers.BrowserProvider(window.ethereum);
      const payg = new ethers.Contract(paygContractAddress, paygABI, provider);
      const [tbCommitted, storagePaidThrough, lastMaintenancePaidAt, storageActive, maintenanceCurrent] = await payg.getSubscriptionStatus(address);
      setPaygStatus({
        tbCommitted: Number(tbCommitted),
        storagePaidThrough: Number(storagePaidThrough) * 1000,
        lastMaintenancePaidAt: Number(lastMaintenancePaidAt) * 1000,
        storageActive,
        maintenanceCurrent
      });
      return provider;
    } catch (err) {
      console.warn("PAYG subscription status view call failed:", err);
    }
  };

  const fetchPaygHistory = async (address) => {
    if (!address || typeof window === 'undefined' || !window.ethereum) return;
    setIsLoadingPaygHistory(true);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const payg = new ethers.Contract(paygContractAddress, paygABI, provider);
      const latestBlock = await provider.getBlockNumber();
      const fromBlock = latestBlock - 4900 > 0 ? latestBlock - 4900 : 0;

      const [storageLogs, egressLogs, maintenanceLogs] = await Promise.all([
        payg.queryFilter(payg.filters.StorageSubscriptionPaid(address), fromBlock, 'latest'),
        payg.queryFilter(payg.filters.EgressFeePaid(address), fromBlock, 'latest'),
        payg.queryFilter(payg.filters.AnnualMaintenancePaid(address), fromBlock, 'latest')
      ]);

      const merged = [
        ...storageLogs.map(log => ({
          type: 'Storage Subscription',
          asset: 'USDT',
          units: `${log.args.tbUnits.toString()} TB`,
          amount: ethers.formatUnits(log.args.amountPaid, 18),
          timestamp: Number(log.args.paidThrough) * 1000 - 30 * 24 * 60 * 60 * 1000,
          txHash: log.transactionHash
        })),
        ...egressLogs.map(log => ({
          type: 'Egress (Retrieval)',
          asset: 'INAYA',
          units: `${log.args.halfTbUnits.toString()} × 0.5 TB`,
          amount: ethers.formatUnits(log.args.amountPaid, 18),
          timestamp: Number(log.args.timestamp) * 1000,
          txHash: log.transactionHash
        })),
        ...maintenanceLogs.map(log => ({
          type: 'Annual Maintenance',
          asset: 'USDT',
          units: '—',
          amount: ethers.formatUnits(log.args.amountPaid, 18),
          timestamp: Number(log.args.nextDueAt) * 1000 - 365 * 24 * 60 * 60 * 1000,
          txHash: log.transactionHash
        }))
      ].sort((a, b) => b.timestamp - a.timestamp);

      setPaygHistory(merged);
    } catch (err) {
      console.error("PAYG history extraction failed:", err);
      setPaygHistory([]);
    } finally {
      setIsLoadingPaygHistory(false);
    }
  };

  const refreshPaygDashboard = async (address) => {
    if (!address || typeof window === 'undefined' || !window.ethereum) return;
    const provider = new ethers.BrowserProvider(window.ethereum);
    await Promise.all([fetchPaygPricing(provider), fetchPaygStatus(address, provider), fetchPaygHistory(address)]);
  };

  // ========================================================
  // 🥩 STAKING — OVERVIEW FETCH + STAKE / UNSTAKE / CLAIM HANDLERS
  // ========================================================
  const refreshStakingOverview = async (address) => {
    if (typeof window === 'undefined' || !window.ethereum) return;
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const staking = new ethers.Contract(stakingContractAddress, stakingABI, provider);

      const [totalStaked, rate, tierLabel] = await Promise.all([
        staking.totalStaked(),
        staking.rewardRate(),
        address ? staking.getUserTier(address) : Promise.resolve('None')
      ]);

      // APY estimate: (rewardRate * seconds/year) / totalStaked, annualized.
      // Falls back to 0% if nothing is staked yet (avoids a divide-by-zero display).
      const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
      let apyPercent = "0.00";
      if (totalStaked > 0n) {
        const annualRewardWei = rate * BigInt(SECONDS_PER_YEAR);
        const apyBps = (annualRewardWei * 10000n) / totalStaked;
        apyPercent = (Number(apyBps) / 100).toFixed(2);
      }

      let myBalance = 0n;
      let claimable = 0n;
      let expiry = 0;
      if (address) {
        [myBalance, claimable, expiry] = await Promise.all([
          staking.userStakedBalance(address),
          staking.earned(address),
          staking.lockExpiry(address)
        ]);
      }

      setStakingOverview({
        totalStakedTVL: ethers.formatUnits(totalStaked, 18),
        estimatedAPY: apyPercent,
        myStakedBalance: ethers.formatUnits(myBalance, 18),
        claimableRewards: ethers.formatUnits(claimable, 18),
        lockExpiryTimestamp: Number(expiry) * 1000,
        userTier: tierLabel
      });
    } catch (err) {
      console.warn("Staking overview fetch failed:", err);
    }
  };

  const handleStakeInaya = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (stakingActionLockRef.current || isStakingBusy) return;
    const amount = parseFloat(stakeAmountInput);
    if (!amount || amount <= 0) { alert("🚨 Enter a valid amount to stake."); return; }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    stakingActionLockRef.current = true;
    setIsStakingBusy(true);
    setStakingLog(`🔄 Preparing to stake ${amount} $INAYA (${selectedLockTier === 0 ? 'Flexible' : selectedLockTier + '-day lock'})...`);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const inayaContract = new ethers.Contract(inayaTokenAddress, erc20ABI, signer);
      const staking = new ethers.Contract(stakingContractAddress, stakingABI, signer);

      const amountWei = ethers.parseUnits(stakeAmountInput, 18);

      const balance = await inayaContract.balanceOf(walletAddress);
      if (balance < amountWei) {
        alert(`🚨 Insufficient $INAYA balance. You have ${ethers.formatUnits(balance, 18)}.`);
        setStakingLog("❌ Blocked before signing: insufficient $INAYA balance.");
        return;
      }

      const allowance = await inayaContract.allowance(walletAddress, stakingContractAddress);
      if (allowance < amountWei) {
        setStakingLog("✍️ Requesting $INAYA spending approval for the staking contract...");
        const approveTx = await inayaContract.approve(stakingContractAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      setStakingLog(`✍️ Signing stake transaction for ${amount} $INAYA...`);
      const tx = await staking.stake(amountWei, selectedLockTier);
      setStakingLog("⏳ Mining stake transaction...");
      await tx.wait();

      setStakingLog(`💚 Staked ${amount} $INAYA successfully (${selectedLockTier === 0 ? 'Flexible' : selectedLockTier + '-day lock'}).`);
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      setStakeAmountInput('');
      refreshStakingOverview(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setStakingLog(`❌ Stake failed: ${friendly}`);
      alert(`❌ Stake Failed: ${friendly}`);
    } finally {
      setIsStakingBusy(false);
      stakingActionLockRef.current = false;
    }
  };

  const handleUnstakeInaya = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (stakingActionLockRef.current || isUnstakingBusy) return;
    const amount = parseFloat(unstakeAmountInput);
    if (!amount || amount <= 0) { alert("🚨 Enter a valid amount to unstake."); return; }

    if (stakingOverview.lockExpiryTimestamp > Date.now()) {
      const unlockDate = new Date(stakingOverview.lockExpiryTimestamp).toLocaleString();
      alert(`🚨 Your stake is locked until ${unlockDate}. It cannot be withdrawn early.`);
      return;
    }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    stakingActionLockRef.current = true;
    setIsUnstakingBusy(true);
    setStakingLog(`🔄 Preparing to withdraw ${amount} $INAYA...`);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const staking = new ethers.Contract(stakingContractAddress, stakingABI, signer);

      const amountWei = ethers.parseUnits(unstakeAmountInput, 18);
      setStakingLog(`✍️ Signing withdrawal for ${amount} $INAYA...`);
      const tx = await staking.withdraw(amountWei);
      setStakingLog("⏳ Mining withdrawal transaction...");
      await tx.wait();

      setStakingLog(`💚 Withdrew ${amount} $INAYA successfully.`);
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      setUnstakeAmountInput('');
      refreshStakingOverview(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setStakingLog(`❌ Withdrawal failed: ${friendly}`);
      alert(`❌ Withdrawal Failed: ${friendly}`);
    } finally {
      setIsUnstakingBusy(false);
      stakingActionLockRef.current = false;
    }
  };

  const handleClaimStakingReward = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (stakingActionLockRef.current || isClaimingBusy) return;

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    stakingActionLockRef.current = true;
    setIsClaimingBusy(true);
    setStakingLog("🔄 Preparing to claim rewards...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const staking = new ethers.Contract(stakingContractAddress, stakingABI, signer);

      setStakingLog("✍️ Signing reward claim...");
      const tx = await staking.claimReward();
      setStakingLog("⏳ Mining claim transaction...");
      await tx.wait();

      setStakingLog("💚 Rewards claimed successfully.");
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      refreshStakingOverview(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setStakingLog(`❌ Claim failed: ${friendly}`);
      alert(`❌ Claim Failed: ${friendly}`);
    } finally {
      setIsClaimingBusy(false);
      stakingActionLockRef.current = false;
    }
  };

  const handlePaygStorageSubscription = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (paygActionLockRef.current || isPaygStorageBusy) return;
    if (!paygTbUnits || paygTbUnits < 1) { alert("🚨 Enter at least 1 TB unit."); return; }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    paygActionLockRef.current = true;
    setIsPaygStorageBusy(true);
    setPaygLog("🔄 Preparing storage subscription payment...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const payg = new ethers.Contract(paygContractAddress, paygABI, signer);
      const usdtContract = new ethers.Contract(usdtTokenAddress, erc20ABI, signer);

      const pricePerTB = await payg.storagePricePerTB();
      const amountDue = pricePerTB * BigInt(paygTbUnits);

      const balance = await usdtContract.balanceOf(walletAddress);
      if (balance < amountDue) {
        alert(`🚨 Insufficient mUSDT balance for ${paygTbUnits} TB. Use the Faucet tab to top up.`);
        setPaygLog("❌ Blocked before signing: insufficient mUSDT balance.");
        return;
      }

      const allowance = await usdtContract.allowance(walletAddress, paygContractAddress);
      if (allowance < amountDue) {
        setPaygLog("✍️ Requesting USDT spending approval...");
        const approveTx = await usdtContract.approve(paygContractAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      setPaygLog(`✍️ Signing storage subscription for ${paygTbUnits} TB...`);
      const tx = await payg.paySubscriptionStorage(paygTbUnits);
      setPaygLog("⏳ Mining storage subscription transaction...");
      await tx.wait();

      setPaygLog(`💚 Storage subscription active: ${paygTbUnits} TB committed for 30 days.`);
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      refreshPaygDashboard(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setPaygLog(`❌ Storage subscription failed: ${friendly}`);
      alert(`❌ Storage Subscription Failed: ${friendly}`);
    } finally {
      setIsPaygStorageBusy(false);
      paygActionLockRef.current = false;
    }
  };

  const handlePaygEgressFee = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (paygActionLockRef.current || isPaygEgressBusy) return;
    if (!paygEgressUnits || paygEgressUnits < 1) { alert("🚨 Enter at least one 0.5 TB unit."); return; }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    paygActionLockRef.current = true;
    setIsPaygEgressBusy(true);
    setPaygLog("🔄 Preparing egress fee payment...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const payg = new ethers.Contract(paygContractAddress, paygABI, signer);
      const inayaContract = new ethers.Contract(inayaTokenAddress, erc20ABI, signer);

      const pricePerHalfTB = await payg.egressPricePerHalfTB();
      const amountDue = pricePerHalfTB * BigInt(paygEgressUnits);

      const balance = await inayaContract.balanceOf(walletAddress);
      if (balance < amountDue) {
        alert(`🚨 Insufficient $INAYA balance for ${paygEgressUnits} × 0.5 TB egress. Use the Faucet tab to top up.`);
        setPaygLog("❌ Blocked before signing: insufficient $INAYA balance.");
        return;
      }

      const allowance = await inayaContract.allowance(walletAddress, paygContractAddress);
      if (allowance < amountDue) {
        setPaygLog("✍️ Requesting $INAYA spending approval...");
        const approveTx = await inayaContract.approve(paygContractAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      setPaygLog(`✍️ Signing egress fee for ${paygEgressUnits} × 0.5 TB...`);
      const tx = await payg.payEgressFee(paygEgressUnits);
      setPaygLog("⏳ Mining egress fee transaction...");
      await tx.wait();

      setPaygLog(`💚 Egress fee settled for ${paygEgressUnits} × 0.5 TB.`);
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      refreshPaygDashboard(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setPaygLog(`❌ Egress fee payment failed: ${friendly}`);
      alert(`❌ Egress Fee Payment Failed: ${friendly}`);
    } finally {
      setIsPaygEgressBusy(false);
      paygActionLockRef.current = false;
    }
  };

  const handlePaygAnnualMaintenance = async () => {
    if (!isConnected || !walletAddress) { alert("🚨 Connect your wallet first."); return; }
    if (paygActionLockRef.current || isPaygMaintenanceBusy) return;

    if (paygStatus.maintenanceCurrent) {
      const proceed = window.confirm("⚠️ Annual maintenance is already paid for the current period on-chain and will revert if resubmitted. Continue anyway?");
      if (!proceed) return;
    }

    const networkCorrect = await ensureCorrectNetwork();
    if (!networkCorrect) { alert("🚨 Please switch your wallet to BNB Chain Testnet first!"); return; }

    paygActionLockRef.current = true;
    setIsPaygMaintenanceBusy(true);
    setPaygLog("🔄 Preparing annual maintenance payment...");
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const payg = new ethers.Contract(paygContractAddress, paygABI, signer);
      const usdtContract = new ethers.Contract(usdtTokenAddress, erc20ABI, signer);

      const fee = await payg.annualMaintenanceFee();

      const balance = await usdtContract.balanceOf(walletAddress);
      if (balance < fee) {
        alert("🚨 Insufficient mUSDT balance for annual maintenance. Use the Faucet tab to top up.");
        setPaygLog("❌ Blocked before signing: insufficient mUSDT balance.");
        return;
      }

      const allowance = await usdtContract.allowance(walletAddress, paygContractAddress);
      if (allowance < fee) {
        setPaygLog("✍️ Requesting USDT spending approval...");
        const approveTx = await usdtContract.approve(paygContractAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      setPaygLog("✍️ Signing annual maintenance payment...");
      const tx = await payg.payAnnualMaintenance();
      setPaygLog("⏳ Mining annual maintenance transaction...");
      await tx.wait();

      setPaygLog("💚 Annual maintenance settled for the next 365-day period.");
      setTxHashLink(`https://testnet.bscscan.com/tx/${tx.hash}`);
      refreshPaygDashboard(walletAddress);
    } catch (err) {
      console.error(err);
      const friendly = err.shortMessage || err.reason || err.message || String(err);
      setPaygLog(`❌ Annual maintenance payment failed: ${friendly}`);
      alert(`❌ Annual Maintenance Payment Failed: ${friendly}`);
    } finally {
      setIsPaygMaintenanceBusy(false);
      paygActionLockRef.current = false;
    }
  };

  // ========================================================
  // 🔎 PROOF REGISTRY READ-ONLY LOOKUPS (view calls, no wallet signature needed)
  // ========================================================
  const fetchAssetProofStatus = async (fileHash) => {
    try {
      if (typeof window === 'undefined' || !window.ethereum) return null;
      const provider = new ethers.BrowserProvider(window.ethereum);
      const proofRegistry = new ethers.Contract(proofRegistryAddress, proofRegistryABI, provider);
      const record = await proofRegistry.getAssetProof(fileHash);
      return {
        merkleRoot: record.merkleRoot,
        chunkCount: Number(record.chunkCount),
        node: record.node,
        registeredAt: Number(record.registeredAt),
        lastVerifiedAt: Number(record.lastVerifiedAt),
        challengesPassed: Number(record.challengesPassed),
        challengesFailed: Number(record.challengesFailed)
      };
    } catch (err) {
      console.error("fetchAssetProofStatus failed:", err);
      return null;
    }
  };

  const fetchNodeReliability = async (nodeAddress) => {
    try {
      if (typeof window === 'undefined' || !window.ethereum) return null;
      const provider = new ethers.BrowserProvider(window.ethereum);
      const proofRegistry = new ethers.Contract(proofRegistryAddress, proofRegistryABI, provider);
      const [passed, failed] = await proofRegistry.getNodeReliability(nodeAddress);
      return { passed: Number(passed), failed: Number(failed) };
    } catch (err) {
      console.error("fetchNodeReliability failed:", err);
      return null;
    }
  };

  // UI handler: accepts either a raw 0x fileHash or a plain Asset Tracking ID (same convention
  // used by handleRetrievalSequence — hashed with computeFileHash if it's not already a hash).
  const handleProofLookup = async () => {
    const raw = proofLookupInput.trim();
    if (!raw) { alert("🚨 Enter an Asset Tracking ID or file hash first!"); return; }
    const fileHash = raw.startsWith('0x') && raw.length === 66 ? raw : computeFileHash(raw);

    setIsLoadingProofLookup(true);
    setProofLookupResult(null);
    try {
      const result = await fetchAssetProofStatus(fileHash);
      if (!result || result.registeredAt === 0) {
        setProofLookupResult({ notFound: true });
      } else {
        setProofLookupResult(result);
      }
    } finally {
      setIsLoadingProofLookup(false);
    }
  };

  const handleNodeReliabilityLookup = async () => {
    const raw = nodeLookupInput.trim();
    if (!raw || !ethers.isAddress(raw)) { alert("🚨 Enter a valid node wallet address!"); return; }

    setIsLoadingNodeLookup(true);
    setNodeLookupResult(null);
    try {
      const result = await fetchNodeReliability(raw);
      setNodeLookupResult(result);
    } finally {
      setIsLoadingNodeLookup(false);
    }
  };

  const handleFaucetRequest = async () => {
    if (!isConnected || !walletAddress) { alert("Connect your wallet first to request test tokens."); return; }
    setIsFauceting(true);
    setFaucetLog("📡 Requesting test tokens from the Inaya faucet...");
    try {
      const res = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress })
      });
      const data = await res.json();
      if (!res.ok || !data.success) { throw new Error(data.error || "Faucet request failed."); }
      const lines = [];
      lines.push(data.results.inaya.sent ? `✅ Sent ${data.results.inaya.amount} $INAYA` : `ℹ️ $INAYA: ${data.results.inaya.reason}`);
      lines.push(data.results.usdt.sent ? `✅ Sent ${data.results.usdt.amount} mUSDT` : `ℹ️ mUSDT: ${data.results.usdt.reason}`);
      setFaucetLog(lines.join('   •   '));
    } catch (err) {
      console.error(err);
      setFaucetLog(`❌ Faucet request failed: ${err.message}`);
    } finally {
      setIsFauceting(false);
    }
  };

  const handleSubmitSocial = async () => {
    if(!socialHandle) return alert("Validation Core Error: Fill social reference mapping tag.");
    if(!isConnected) return alert("Web3 Engine Error: Connect wallet target index matrix.");
    
    try {
      setStatusLog("📡 Logging telemetry handle parameters into identity servers...");
      const res = await fetch('/api/points', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: walletAddress.toLowerCase(), actionType: 'SOCIAL', handle: socialHandle })
      });
      const responseData = await res.json();
      if (res.ok) {
        alert(`Success: ${socialHandle} verification tracking parameters mapped securely!`);
        fetchUserPoints(walletAddress);
      } else {
        throw new Error(responseData.error || "Database update rejection pipeline error.");
      }
    } catch (err) { alert(`Backend Sync Dropped: ${err.message}`); }
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

  useEffect(() => {
    if (isConnected && currentPage === 'Sovereign Vault') { fetchOnChainHistory(); }
    if (isConnected && walletAddress) { fetchUserPoints(walletAddress); }
    if (isConnected && walletAddress && (currentPage === 'Business Model' || currentPage === 'My Dashboard')) {
      refreshPaygDashboard(walletAddress);
      setActiveCorporatePlan(getActiveCorporatePlan(walletAddress));
    }
    if (currentPage === 'Staking') {
      refreshStakingOverview(walletAddress || null); // works read-only even if not connected
    }
  }, [isConnected, currentPage, walletAddress]);

  // ========================================================
  // 🖥️ WEB3 STRUCTURAL LAYER UI LAYOUTS
  // ========================================================
  const hasEnoughInaya = userInayaBalance >= requiredInayaWei;
  const hasEnoughUsdt = userUsdtBalance >= requiredUsdtWei;
  const totalSelectedMB = selectedFiles.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);
  const oversizedFiles = selectedFiles.filter(f => f.size / (1024 * 1024) > b2bTierData.maxFileMB);
  const isOverTotalLimit = totalSelectedMB > b2bTierData.maxTotalMB;
  const hasSizeViolation = oversizedFiles.length > 0 || isOverTotalLimit;

  // ========================================================
  // 💵 PAYG DASHBOARD DERIVED TOTALS
  // ========================================================
  const paygTotalUsdtSpent = paygHistory
    .filter(item => item.asset === 'USDT')
    .reduce((acc, item) => acc + parseFloat(item.amount || "0"), 0);
  const paygTotalInayaSpent = paygHistory
    .filter(item => item.asset === 'INAYA')
    .reduce((acc, item) => acc + parseFloat(item.amount || "0"), 0);
  const corporateTierToTB = { '250 TB / Year': 250, '500 TB / Year': 500, '1000 TB / Year': 1000 };
  const corporateAllocatedTB = activeCorporatePlan ? (corporateTierToTB[activeCorporatePlan.tier] || 0) : 0;
  const totalSpaceAllocatedTB = paygStatus.tbCommitted + corporateAllocatedTB;

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans w-full overflow-x-hidden">
      
      {/* GLOBAL TOP HEADER DISPLAY LAYER */}
      <header className="flex flex-col sm:flex-row gap-4 justify-between items-center bg-[#0a0f1e]/80 border-b border-[#00f2fe]/15 px-4 md:px-10 py-4 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] w-3.5 h-3.5 rounded-sm shadow-[0_0_10px_#00f2fe]"></div>
          <span className="text-white font-extrabold text-lg tracking-wider">INAYA NETWORK</span>
          <span className="text-[10px] ml-2 font-mono px-3 py-0.5 rounded-full font-bold border bg-cyan-500/10 text-[#00f2fe] border-[#00f2fe]/30">⚡ LOW-COST DEPIN DISRUPTOR PLATFORM</span>
        </div>
        <button onClick={() => isConnected ? null : setIsWalletModalOpen(true)} className="px-6 py-2 rounded-full text-xs font-mono font-bold bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] transition-transform active:scale-95">
          {isConnected ? `🛡️ ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4).toUpperCase()}` : '🔌 CONNECT WALLET'}
        </button>
      </header>

      {/* FRAME CONTROLLER DOCK PLATFORM */}
      <div className="flex flex-col md:flex-row w-full">
        
        {/* ASIDE SECURITY MODULE */}
        <aside className="w-full md:w-80 border-b md:border-b-0 md:border-r border-white/5 bg-[#080c18]/60 p-6 min-h-auto md:min-h-[calc(100vh-80px)] backdrop-blur-md space-y-7">

          {/* DOCK HEADER */}
          <div className="flex items-center gap-2.5 pb-1">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/25 flex items-center justify-center text-sm">
              🛡️
            </div>
            <div>
              <div className="text-white text-sm font-bold tracking-wide leading-tight">Security Dock</div>
              <div className="text-[9px] text-[#64748b] uppercase tracking-wider">Network diagnostics &amp; identity</div>
            </div>
          </div>

          {/* B2B CORPORATE RESERVE PANEL CHANGER */}
          <div className="bg-[#0b1426]/70 border border-[#00f2fe]/20 p-4 rounded-xl space-y-3 font-mono text-[11px]">
            <div className="text-[#00f2fe] font-extrabold text-xs uppercase border-b border-white/5 pb-1">Corporate Reserve Panel</div>
            <div>
              <span className="text-slate-400 block mb-1">Select Active Annual Plan:</span>
              <select value={selectedB2BTier} onChange={(e) => setSelectedB2BTier(e.target.value)} className="w-full bg-[#060913] border border-white/10 rounded px-2 py-1 text-white font-bold text-xs cursor-pointer focus:outline-none">
                <option value="250 TB / Year">250 TB / Year (13,500 USDT/yr)</option>
                <option value="500 TB / Year">500 TB / Year (27,000 USDT/yr)</option>
                <option value="1000 TB / Year">1000 TB / Year (54,000 USDT/yr)</option>
              </select>
            </div>
            <div className="pt-1 text-slate-300 space-y-1">
              <div>• Reserve Fee: <span className="text-white font-bold">{b2bTierData.price}</span></div>
              <div>• Annual Maintenance: <span className="text-white font-bold">{b2bTierData.maintenance}</span></div>
              <div>• Allocation Limit: <span className="text-white font-bold">{b2bTierData.displayLimit}</span></div>
              <div className="text-[10px] text-slate-500 italic pt-1">{b2bTierData.inclusions}</div>
            </div>
            <div className="text-[9.5px] text-slate-500 pt-1 border-t border-white/5">
              Retail / pay-as-you-go storage remains available at the baseline <span className="text-[#00f2fe] font-bold">4.5 USDT / TB / month</span> rate outside of a Corporate Reserve plan.
            </div>
          </div>

          {/* DEPLOYED CONTRACTS */}
          <div>
            <div className="text-[10px] font-mono font-bold text-[#64748b] uppercase tracking-widest mb-2.5 px-0.5">Deployed Contracts</div>
            <div className="bg-white/[0.02] border border-white/5 rounded-xl divide-y divide-white/5 overflow-hidden">

              {/* Core Contract Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-mono text-[#94a3b8] font-semibold">Core Custody Contract</span>
                  <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${liveContractAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={liveContractAddress}
                  >
                    {truncateAddress(liveContractAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(liveContractAddress, 'core')}
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'core' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${liveContractAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[9px] text-[#64748b] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Mock USDT Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-mono text-[#94a3b8] font-semibold">Mock USDT Contract</span>
                  <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${usdtTokenAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={usdtTokenAddress}
                  >
                    {truncateAddress(usdtTokenAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(usdtTokenAddress, 'usdt')}
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'usdt' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${usdtTokenAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[9px] text-[#64748b] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Token Contract Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-mono text-[#94a3b8] font-semibold">$INAYA Token Contract</span>
                  <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${inayaTokenAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={inayaTokenAddress}
                  >
                    {truncateAddress(inayaTokenAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(inayaTokenAddress, 'token')}
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'token' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${inayaTokenAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[9px] text-[#64748b] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Inaya Node Registry Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-mono text-[#94a3b8] font-semibold">Node Registry Contract</span>
                  <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${nodeRegistryAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={nodeRegistryAddress}
                  >
                    {truncateAddress(nodeRegistryAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(nodeRegistryAddress, 'nodeRegistry')}
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'nodeRegistry' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${nodeRegistryAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[9px] text-[#64748b] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Inaya Revenue Router Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-mono text-[#94a3b8] font-semibold">Revenue Router Contract</span>
                  <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${revenueRouterAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={revenueRouterAddress}
                  >
                    {truncateAddress(revenueRouterAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(revenueRouterAddress, 'revenueRouter')}
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'revenueRouter' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${revenueRouterAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[9px] text-[#64748b] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

              {/* Proof Registry Row */}
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-mono text-[#94a3b8] font-semibold">Proof Registry Contract</span>
                  <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                    ✓ Verified
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://testnet.bscscan.com/address/${proofRegistryAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#00f2fe] text-xs font-mono font-bold hover:text-cyan-300 transition-colors flex-1 truncate"
                    title={proofRegistryAddress}
                  >
                    {truncateAddress(proofRegistryAddress)}
                  </a>
                  <button
                    onClick={() => copyToClipboard(proofRegistryAddress, 'proofregistry')}
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0 px-1.5"
                    title="Copy address"
                  >
                    {copiedField === 'proofregistry' ? '✅' : '📋'}
                  </button>
                  <a
                    href={`https://testnet.bscscan.com/address/${proofRegistryAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-[#64748b] hover:text-[#00f2fe] transition-colors shrink-0"
                    title="View on BscScan"
                  >
                    ↗
                  </a>
                </div>
                <div className="text-[9px] text-[#64748b] mt-1.5 font-mono">BNB Chain Testnet</div>
              </div>

            </div>
          </div>

          {/* NODE IDENTITY */}
          <div>
            <div className="text-[10px] font-mono font-bold text-[#64748b] uppercase tracking-widest mb-2.5 px-0.5">Node Identity</div>
            <div className="border border-[#00f2fe]/20 bg-gradient-to-b from-[#0c162b]/80 to-[#0c162b]/40 p-4 rounded-xl">
              <div className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-[#64748b]'}`}></span>
                <span className="text-[#00f2fe] font-mono text-[10px] font-bold uppercase tracking-wide">Node Authentication</span>
              </div>
              {isConnected ? (
                isSignedUp ? (
                  <div className="mt-3 flex items-center gap-2 text-xs font-mono text-emerald-400 font-bold">
                    <span>✓</span> NODE OPERATIONAL (VERIFIED)
                  </div>
                ) : (
                  <button onClick={handleWeb3SignUp} disabled={isSigning} className="w-full mt-3 py-2 bg-gradient-to-r from-amber-500 to-orange-600 text-slate-900 font-bold text-xs rounded-lg animate-pulse">
                    {isSigning ? "SIGNING..." : "📝 COMPLETE SIGN UP (VERIFY NODE)"}
                  </button>
                )
              ) : (
                <div className="text-[#64748b] text-[11px] italic mt-3 font-mono">// Connect wallet to sign up.</div>
              )}
            </div>
          </div>

          {/* VAULT ACCESS */}
          <div>
            <div className="text-[10px] font-mono font-bold text-[#64748b] uppercase tracking-widest mb-2.5 px-0.5">Vault Access</div>
            <label className="block text-xs text-[#94a3b8] font-semibold mb-2">Master Node Passkey</label>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#64748b] text-xs">🔒</span>
              <input type="password" value={masterPasskey} onChange={(e) => setMasterPasskey(e.target.value)} placeholder="••••••••" className="w-full bg-[#090d16] border border-white/10 rounded-lg pl-9 pr-4 py-2.5 text-white text-sm font-mono focus:outline-none focus:border-[#00f2fe]/40 transition-colors" />
            </div>
            <div className="flex gap-2 mt-2.5 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg p-2.5">
              <span className="text-amber-400 text-xs shrink-0">⚠️</span>
              <p className="text-[10px] text-amber-400/80 font-mono leading-relaxed">
                Never stored or transmitted. If lost, encrypted data cannot be recovered by you or by Inaya Network — there is no backdoor or reset.
              </p>
            </div>
          </div>

        </aside>

        {/* MAIN ROUTER ROUTING INTERFACE HOOK */}
        <main className="flex-1 p-4 md:p-10 w-full overflow-x-hidden">
          
          <nav className="grid grid-cols-2 sm:grid-cols-3 md:flex bg-[#090d15]/60 border border-white/5 p-1.5 rounded-xl max-w-5xl mx-auto mb-10 gap-2 backdrop-blur-md">
            {['Network Home', 'Faucet', 'Sovereign Vault', 'Business Model', 'Staking', 'My Dashboard', 'Genesis Airdrop', 'White Paper', 'About Us'].map((tab) => (
              <button key={tab} onClick={() => setCurrentPage(tab)} className={`flex-1 text-center py-2.5 text-xs font-semibold rounded-lg tracking-wide transition-all ${currentPage === tab ? 'text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40' : 'text-[#64748b] hover:text-slate-300'}`}>{tab}</button>
            ))}
          </nav>

          {/* VIEWPORT AREA 1: HOME PANEL */}
          {currentPage === 'Network Home' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">Sovereign Data Storage Networks</h2>
              <p className="text-[#94a3b8] text-sm mb-8">Client-side encrypted storage with on-chain attestation — no central server ever holds your data whole.</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? (isSignedUp ? "ACTIVE_NODE" : "UNVERIFIED_SIGNUP") : "WAITING_AUTH"}</div><div className="text-[10px] uppercase text-[#64748b] mt-1">Wallet Core Status</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">30,000,000</div><div className="text-[10px] uppercase text-[#64748b] mt-1">Supply Cap Weight</div></div>
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl"><div className="font-mono text-xl font-bold text-white">{isConnected ? "LIVE" : "IDLE"}</div><div className="text-[10px] uppercase text-[#64748b] mt-1">RPC Connection Status</div></div>
              </div>
            </div>
          )}

          {/* VIEWPORT AREA 1B: TESTNET FAUCET */}
          {currentPage === 'Faucet' && (
            <div className="max-w-3xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">🚰 Testnet Token Faucet</h2>
              <p className="text-[#94a3b8] text-sm mb-2">Get free test $INAYA and mUSDT to try the dual-asset upload flow — no real value, BNB Chain Testnet only.</p>

              <div className="bg-[#0b1120]/40 border border-white/5 rounded-2xl p-6 space-y-5">
                <div className="grid grid-cols-2 gap-4 font-mono text-xs">
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-emerald-400">500</div>
                    <div className="text-[10px] text-[#64748b] uppercase tracking-wider mt-1">$INAYA per request</div>
                  </div>
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 text-center">
                    <div className="text-2xl font-bold text-[#00f2fe]">100</div>
                    <div className="text-[10px] text-[#64748b] uppercase tracking-wider mt-1">mUSDT per request</div>
                  </div>
                </div>

                {faucetLog && (
                  <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl break-words">
                    {faucetLog}
                  </div>
                )}

                <button
                  onClick={handleFaucetRequest}
                  disabled={isFauceting || !isConnected}
                  className="w-full py-3 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-xl shadow-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isFauceting ? "DISPENSING..." : isConnected ? "REQUEST TEST TOKENS" : "CONNECT WALLET FIRST"}
                </button>

                <p className="text-[10px] text-[#64748b] font-mono">
                  The faucet skips a token if your wallet already holds enough for testing — this keeps the treasury available for everyone.
                </p>
              </div>

              <div className="bg-black/20 border border-white/5 rounded-2xl p-5 font-mono text-[10px] text-[#64748b] leading-relaxed">
                <p className="mb-1"><span className="text-amber-400/80 font-bold">⛽ Need gas (tBNB) too?</span> This faucet only covers $INAYA and mUSDT.</p>
                <p>Get free testnet BNB here: <a href="https://faucet.zalalena.com/bsc" target="_blank" rel="noopener noreferrer" className="text-[#00f2fe] underline hover:text-cyan-300">faucet.zalalena.com/bsc</a></p>
              </div>
            </div>
          )}

          {/* VIEWPORT AREA 2: CRYPTOGRAPHIC VAULT LAYER */}
{currentPage === 'Sovereign Vault' && (
  <div className="max-w-7xl mx-auto space-y-6 font-sans">
    
    {/* 1. GOOGLE DRIVE TOP SEARCH & ACTION BAR */}
    <div className="bg-[#0b101d]/90 border border-white/10 rounded-2xl p-4 flex flex-col md:flex-row items-center justify-between gap-4 backdrop-blur-xl shadow-xl">
      
      {/* Top Search Bar */}
      <div className="relative flex-1 w-full">
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
        <input 
          type="text" 
          value={queryAssetId} 
          onChange={(e) => setQueryAssetId(e.target.value)} 
          placeholder="Search in Inaya Drive (Asset ID or Hash)..." 
          className="w-full bg-[#040711] border border-white/10 rounded-full pl-11 pr-28 py-2.5 text-white text-xs focus:outline-none focus:border-[#00f2fe] transition-all"
        />
        <button 
          onClick={() => handleRetrievalSequence('')}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 px-4 py-1.5 bg-[#00f2fe] text-[#060913] font-bold text-[11px] rounded-full hover:brightness-110 transition-all"
        >
          🧩 RECONSTRUCT
        </button>
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-3 shrink-0">
        <input ref={fileInputRef} type="file" multiple onChange={(e) => setSelectedFiles(Array.from(e.target.files))} className="hidden" />
        <button 
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          className="px-5 py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-extrabold text-xs rounded-full shadow-lg hover:brightness-110 active:scale-95 transition-all flex items-center gap-2"
        >
          <span className="text-base leading-none">┼</span>
          <span>NEW UPLOAD</span>
        </button>
        
        <button 
          onClick={fetchOnChainHistory} 
          className="p-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-slate-300 transition-colors"
          title="Refresh Drive Matrix"
        >
          🔄
        </button>
      </div>
    </div>

    {/* SYSTEM NOTIFICATION BARS */}
    {statusLog && (
      <div className="bg-[#091224] border border-[#00f2fe]/30 text-[#00f2fe] font-mono text-xs p-3.5 rounded-xl break-all flex items-center gap-2 shadow-lg">
        <span className="animate-pulse">⚡</span>
        <span>{statusLog}</span>
      </div>
    )}

    {downloadUrl && (
      <div className="text-xs font-mono bg-cyan-950/80 p-4 rounded-xl border border-[#00f2fe]/40 text-[#00f2fe] flex justify-between items-center shadow-lg">
        <span>🔓 Decrypted File Payload Ready: <strong>{restoredName}</strong></span>
        <a href={downloadUrl} download={restoredName} className="px-4 py-1.5 bg-[#00f2fe] text-[#060913] font-bold rounded-lg hover:brightness-110">
          📥 DOWNLOAD FILE
        </a>
      </div>
    )}

    {/* 2. PENDING UPLOAD BAR (Appears when files are chosen) */}
    {selectedFiles.length > 0 && (
      <div className="bg-[#0a1224] border border-[#00f2fe]/40 rounded-2xl p-5 space-y-4 shadow-2xl animate-fade-in">
        <div className="flex justify-between items-center border-b border-white/10 pb-3">
          <div className="flex items-center gap-2">
            <span className="text-base">📤</span>
            <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">Pending Upload Queue ({selectedFiles.length} File)</span>
          </div>
          <button onClick={() => setSelectedFiles([])} className="text-xs text-slate-400 hover:text-red-400 font-mono">Clear Queue ✕</button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono">
          <div className="md:col-span-2 space-y-2 max-h-32 overflow-y-auto pr-1">
            {selectedFiles.map((f, idx) => {
              const meta = splitFileName(f.name);
              return (
                <div key={idx} className="flex justify-between items-center bg-[#040711] border border-white/10 rounded-xl px-3 py-2 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span>{getFileIcon(f.name)}</span>
                    <span className="text-white font-bold truncate">{meta.base}</span>
                  </div>
                  <span className="text-[9px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 px-2 py-0.5 rounded border border-[#00f2fe]/30">.{meta.ext}</span>
                </div>
              );
            })}
          </div>

          <div className="bg-[#040711] border border-white/10 rounded-xl p-3 flex flex-col justify-between font-mono text-[11px]">
            <div className="space-y-1">
              <input 
                type="text" 
                value={assetId} 
                onChange={(e) => setAssetId(e.target.value)} 
                placeholder="Assign Asset Tracking ID..." 
                className="w-full bg-[#0a0f1d] border border-white/10 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-[#00f2fe]" 
              />
              <div className="flex justify-between text-slate-400 pt-1">
                <span>Fee:</span>
                <span className="text-emerald-400 font-bold">{dynamicInayaCost} $INAYA</span>
              </div>
            </div>

            <button 
              onClick={handleUploadSequence} 
              className="w-full mt-2 py-2 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-extrabold text-xs rounded-lg hover:brightness-110 active:scale-95 transition-all"
            >
              ⚡ EMIT TO DRIVE
            </button>
          </div>
        </div>
      </div>
    )}

    {/* 3. GOOGLE DRIVE MAIN LAYOUT & SUGGESTED FILES MATRIX */}
    <div className="bg-[#0b101d]/90 border border-white/10 rounded-2xl p-6 backdrop-blur-xl shadow-2xl space-y-4">
      
      {/* Header Banner */}
      <div className="border-b border-white/5 pb-3 flex justify-between items-center">
        <div>
          <h3 className="text-lg font-bold text-white tracking-tight">Welcome to Inaya Sovereign Drive</h3>
          <p className="text-xs text-slate-400 font-mono mt-0.5">Encrypted client-side storage fragments anchored on BNB Chain</p>
        </div>
        <span className="text-xs font-mono text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 px-3 py-1 rounded-full font-bold">
          {vaultHistory.length} Files Stored
        </span>
      </div>

      <div className="text-xs font-bold text-slate-400 font-mono uppercase tracking-wider pt-2">
        Suggested Files
      </div>

      {isLoadingHistory ? (
        <div className="py-16 text-center font-mono text-xs text-slate-500 border border-dashed border-white/10 rounded-2xl">
          ⚙️ Loading Drive files from blockchain ledger...
        </div>
      ) : vaultHistory.length === 0 ? (
        <div className="py-16 text-center font-mono text-xs text-slate-500 italic border border-dashed border-white/10 rounded-2xl">
          // Drive is empty. Click "+ NEW UPLOAD" above to store your first encrypted file.
        </div>
      ) : (
        /* EXACT GOOGLE DRIVE TILES GRID */
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
          {vaultHistory.map((item, index) => {
            const fileMeta = splitFileName(item.filename || item.assetIdText || 'Document');
            const isPdf = fileMeta.ext === 'PDF';
            const isImg = ['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP'].includes(fileMeta.ext);

            return (
              <div 
                key={index}
                className="group bg-[#040711] border border-white/10 hover:border-[#00f2fe]/60 rounded-2xl p-3.5 transition-all duration-200 flex flex-col justify-between hover:shadow-[0_0_25px_rgba(0,242,254,0.15)] relative"
              >
                {/* Top Tile Bar: File Badge + Title + Options Menu */}
                <div className="flex items-center gap-2 mb-2 min-w-0">
                  <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border uppercase shrink-0 ${
                    isPdf ? 'bg-red-500/10 text-red-400 border-red-500/30' : isImg ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' : 'bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30'
                  }`}>
                    {fileMeta.ext}
                  </span>

                  <h4 className="text-white text-xs font-bold font-mono truncate flex-1 group-hover:text-[#00f2fe] transition-colors" title={item.filename}>
                    {fileMeta.base}
                  </h4>

                  <button 
                    onClick={() => setQueryAssetId(item.assetIdText || item.assetId)}
                    className="text-slate-500 hover:text-white p-1 rounded font-bold text-xs shrink-0"
                    title="Select Asset ID"
                  >
                    ⋮
                  </button>
                </div>

                {/* Main Card Body (Google Drive Preview Box) */}
                <div 
                  onClick={() => setQueryAssetId(item.assetIdText || item.assetId)}
                  className="h-32 bg-[#090e1f] rounded-xl border border-white/5 group-hover:border-[#00f2fe]/30 flex flex-col items-center justify-center mb-3 cursor-pointer transition-all relative overflow-hidden group/preview"
                >
                  <span className="text-5xl group-hover/preview:scale-110 transition-transform duration-300 mb-1">
                    {getFileIcon(item.filename)}
                  </span>
                  <span className="text-[9.5px] text-slate-500 font-mono">Encrypted Payload</span>
                </div>

                {/* Bottom Metadata Bar (Google Drive Owner Avatar & Reconstruct Action) */}
                <div className="flex justify-between items-center pt-2 border-t border-white/5 font-mono text-[10px]">
                  <div className="flex items-center gap-1.5 text-slate-400 min-w-0">
                    <span className="w-4 h-4 rounded-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] flex items-center justify-center text-[8px] text-[#060913] font-black shrink-0">
                      I
                    </span>
                    <span className="truncate text-slate-400">
                      {item.assetIdText ? `#${item.assetIdText}` : 'Owner'}
                    </span>
                  </div>

                  <button 
                    onClick={() => handleRetrievalSequence(item.assetIdText || item.assetId)}
                    className="px-2.5 py-1 bg-[#00f2fe]/10 hover:bg-[#00f2fe] text-[#00f2fe] hover:text-[#060913] border border-[#00f2fe]/30 font-bold rounded-lg transition-all shrink-0"
                  >
                    🧩 RECONSTRUCT
                  </button>
                </div>

              </div>
            );
          })}
        </div>
      )}

    </div>

    {/* 🌳 PROOF-OF-STORAGE STATUS & NODE RELIABILITY PANEL */}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

      {/* Asset Proof Status Lookup */}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-white">🌳 Asset Proof Status</h3>
        <p className="text-[10px] text-[#64748b] font-mono leading-relaxed">Look up the on-chain Merkle root + challenge history for an Asset Tracking ID (InayaProofRegistry).</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={proofLookupInput}
            onChange={(e) => setProofLookupInput(e.target.value)}
            placeholder="Asset Tracking ID or 0x fileHash"
            className="flex-1 bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00f2fe]/30"
          />
          <button
            onClick={handleProofLookup}
            disabled={isLoadingProofLookup}
            className="px-4 py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-lg shadow-lg hover:brightness-110 transition-all whitespace-nowrap disabled:opacity-50"
          >
            {isLoadingProofLookup ? '⏳' : 'CHECK'}
          </button>
        </div>

        {proofLookupResult && (
          proofLookupResult.notFound ? (
            <div className="text-[11px] font-mono text-amber-400/80 bg-amber-500/[0.06] border border-amber-500/20 rounded-lg p-3">
              No Merkle root registered on-chain for this asset yet.
            </div>
          ) : (
            <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-2 font-mono text-[11px]">
              <div className="flex justify-between"><span className="text-[#64748b]">Merkle Root</span><span className="text-[#00f2fe] truncate max-w-[60%]" title={proofLookupResult.merkleRoot}>{truncateAddress(proofLookupResult.merkleRoot)}</span></div>
              <div className="flex justify-between"><span className="text-[#64748b]">Chunk Count</span><span className="text-white">{proofLookupResult.chunkCount}</span></div>
              <div className="flex justify-between"><span className="text-[#64748b]">Assigned Node</span><span className="text-white truncate max-w-[60%]" title={proofLookupResult.node}>{proofLookupResult.node === ethers.ZeroAddress ? '— unassigned —' : truncateAddress(proofLookupResult.node)}</span></div>
              <div className="flex justify-between"><span className="text-[#64748b]">Registered At</span><span className="text-white">{proofLookupResult.registeredAt ? new Date(proofLookupResult.registeredAt * 1000).toLocaleString() : '—'}</span></div>
              <div className="flex justify-between"><span className="text-[#64748b]">Last Verified</span><span className="text-white">{proofLookupResult.lastVerifiedAt ? new Date(proofLookupResult.lastVerifiedAt * 1000).toLocaleString() : 'Never'}</span></div>
              <div className="flex justify-between"><span className="text-emerald-400">Challenges Passed</span><span className="text-emerald-400 font-bold">{proofLookupResult.challengesPassed}</span></div>
              <div className="flex justify-between"><span className="text-red-400">Challenges Failed</span><span className="text-red-400 font-bold">{proofLookupResult.challengesFailed}</span></div>
            </div>
          )
        )}
      </div>

      {/* Node Reliability Lookup */}
      <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-4">
        <h3 className="text-sm font-bold text-white">🛡️ Node Reliability</h3>
        <p className="text-[10px] text-[#64748b] font-mono leading-relaxed">Check any storage node operator's aggregate pass/fail challenge history across every asset they've hosted.</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={nodeLookupInput}
            onChange={(e) => setNodeLookupInput(e.target.value)}
            placeholder="0x Node Wallet Address"
            className="flex-1 bg-[#060913] border border-white/10 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:outline-none focus:border-[#00f2fe]/30"
          />
          <button
            onClick={handleNodeReliabilityLookup}
            disabled={isLoadingNodeLookup}
            className="px-4 py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-xs rounded-lg shadow-lg hover:brightness-110 transition-all whitespace-nowrap disabled:opacity-50"
          >
            {isLoadingNodeLookup ? '⏳' : 'CHECK'}
          </button>
        </div>

        {nodeLookupResult && (() => {
          const total = nodeLookupResult.passed + nodeLookupResult.failed;
          const rate = total > 0 ? ((nodeLookupResult.passed / total) * 100).toFixed(1) : null;
          return (
            <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-2 font-mono text-[11px]">
              <div className="flex justify-between"><span className="text-emerald-400">Challenges Passed</span><span className="text-emerald-400 font-bold">{nodeLookupResult.passed}</span></div>
              <div className="flex justify-between"><span className="text-red-400">Challenges Failed</span><span className="text-red-400 font-bold">{nodeLookupResult.failed}</span></div>
              <div className="flex justify-between"><span className="text-[#64748b]">Reliability Rate</span><span className="text-white font-bold">{rate !== null ? `${rate}%` : 'No challenges yet'}</span></div>
            </div>
          );
        })()}
      </div>

    </div>

  </div>
)}

          {/* 💎 VIEWPORT AREA 2B: BUSINESS MODEL (PAY-AS-YOU-GO + CORPORATE RESERVE) */}
          {currentPage === 'Business Model' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <div className="bg-gradient-to-r from-[#0a1124] to-[#080d1a] border border-[#00f2fe]/20 rounded-2xl p-6 shadow-xl">
                <h2 className="text-base font-black text-white uppercase tracking-wider mb-2">Strategic Business Model &amp; Financial Architecture</h2>
                <p className="text-xs text-slate-400 leading-relaxed font-mono">
                  Retail and developer accounts run on transparent <span className="text-[#00f2fe] font-bold">Pay-As-You-Go</span> pricing settled in stablecoins, while institutional clients can lock in a fixed-cost <span className="text-[#00f2fe] font-bold">Corporate Reserve</span> annual plan. Every invoice — retail or corporate — routes through the dApp's automated USDT→INAYA buyback, driving programmatic TVL into the network vault.
                </p>
              </div>

              {/* PAY-AS-YOU-GO SUMMARY CARDS */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
                <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                  <div className="text-[#00f2fe] font-bold text-lg">4.5 USDT</div>
                  <div className="text-[10px] text-[#64748b] uppercase tracking-wider mt-1">Baseline Storage / TB / Month</div>
                </div>
                <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                  <div className="text-emerald-400 font-bold text-lg">5 INAYA</div>
                  <div className="text-[10px] text-[#64748b] uppercase tracking-wider mt-1">Egress / 0.5 TB Retrieved</div>
                </div>
                <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                  <div className="text-amber-400 font-bold text-lg">5 USDT</div>
                  <div className="text-[10px] text-[#64748b] uppercase tracking-wider mt-1">Flat Annual Maintenance</div>
                </div>
                <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                  <div className="text-violet-400 font-bold text-lg">26.7%</div>
                  <div className="text-[10px] text-[#64748b] uppercase tracking-wider mt-1">Staking Rewards Pool APY Source</div>
                </div>
              </div>

              {/* 💵 PAY-AS-YOU-GO LIVE BILLING PANEL */}
              <div className="bg-[#090d16]/80 border border-[#00f2fe]/20 rounded-2xl p-6 space-y-5">
                <div>
                  <h3 className="text-sm font-bold text-white mb-1">💵 Pay-As-You-Go Live Billing</h3>
                  <p className="text-[10px] text-slate-500 font-mono">Retail metered billing settled directly on-chain against the PAYG contract — independent of the Corporate Reserve checkout below.</p>
                </div>

                {paygLog && (
                  <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-[11px] p-3.5 rounded-xl break-words">
                    {paygLog}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

                  {/* STORAGE SUBSCRIPTION */}
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-3 font-mono">
                    <div className="text-[10px] text-[#64748b] uppercase tracking-wider">Storage Subscription (30 Days)</div>
                    <div className="text-white font-bold text-sm">{paygPricing.storagePerTB} USDT / TB</div>
                    <input
                      type="number"
                      min="1"
                      value={paygTbUnits}
                      onChange={(e) => setPaygTbUnits(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-[#060913] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]/40"
                      placeholder="TB units"
                    />
                    <button
                      onClick={handlePaygStorageSubscription}
                      disabled={isPaygStorageBusy || !isConnected}
                      className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-[11px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPaygStorageBusy ? "PROCESSING..." : "💵 PAY STORAGE (PAYG)"}
                    </button>
                  </div>

                  {/* EGRESS FEE */}
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-3 font-mono">
                    <div className="text-[10px] text-[#64748b] uppercase tracking-wider">Egress / Retrieval Fee</div>
                    <div className="text-white font-bold text-sm">{paygPricing.egressPerHalfTB} INAYA / 0.5 TB</div>
                    <input
                      type="number"
                      min="1"
                      value={paygEgressUnits}
                      onChange={(e) => setPaygEgressUnits(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-[#060913] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]/40"
                      placeholder="0.5 TB units"
                    />
                    <button
                      onClick={handlePaygEgressFee}
                      disabled={isPaygEgressBusy || !isConnected}
                      className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-[11px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPaygEgressBusy ? "PROCESSING..." : "💵 PAY EGRESS (PAYG)"}
                    </button>
                  </div>

                  {/* ANNUAL MAINTENANCE */}
                  <div className="bg-black/20 border border-white/5 rounded-xl p-4 space-y-3 font-mono">
                    <div className="text-[10px] text-[#64748b] uppercase tracking-wider">Annual Maintenance</div>
                    <div className="text-white font-bold text-sm">{paygPricing.maintenanceFee} USDT / Year</div>
                    <div className="text-[10px] text-slate-500 py-2">
                      {paygStatus.maintenanceCurrent ? (
                        <span className="text-emerald-400 font-bold">✓ Current through {new Date(paygStatus.lastMaintenancePaidAt + 365 * 24 * 60 * 60 * 1000).toLocaleDateString()}</span>
                      ) : (
                        <span className="text-amber-400 font-bold">⚠ Not yet paid / lapsed</span>
                      )}
                    </div>
                    <button
                      onClick={handlePaygAnnualMaintenance}
                      disabled={isPaygMaintenanceBusy || !isConnected}
                      className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-[11px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isPaygMaintenanceBusy ? "PROCESSING..." : "💵 PAY MAINTENANCE (PAYG)"}
                    </button>
                  </div>

                </div>

                {isConnected && (
                  <div className="text-[9.5px] text-slate-500 font-mono pt-1 border-t border-white/5">
                    Current PAYG commitment: <span className="text-white font-bold">{paygStatus.tbCommitted} TB</span> · Storage {paygStatus.storageActive ? <span className="text-emerald-400 font-bold">ACTIVE</span> : <span className="text-amber-400 font-bold">LAPSED</span>} until {paygStatus.storagePaidThrough ? new Date(paygStatus.storagePaidThrough).toLocaleDateString() : '—'}
                  </div>
                )}
              </div>

              {/* MARKET PRICING COMPARISON */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 overflow-x-auto">
                <h3 className="text-sm font-bold text-white mb-4">📉 Market Pricing Comparison</h3>
                <table className="w-full text-left font-mono text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400 text-[10px] uppercase">
                      <th className="p-4 font-bold">Provider</th>
                      <th className="p-4 font-bold">Storage (1 TB / Month)</th>
                      <th className="p-4 font-bold">Egress (1 TB Download)</th>
                      <th className="p-4 font-bold">Minimum Duration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-slate-300">
                    <tr><td className="p-4">Amazon S3 (Standard)</td><td className="p-4">~23.00 USDT</td><td className="p-4">~90.00 USDT</td><td className="p-4">30 Days</td></tr>
                    <tr><td className="p-4">Google Cloud Storage</td><td className="p-4">~20.00 USDT</td><td className="p-4">~80.00 USDT</td><td className="p-4">30 Days</td></tr>
                    <tr><td className="p-4">Legacy Web2 (B2)</td><td className="p-4">~6.00 USDT</td><td className="p-4">~10.00 USDT</td><td className="p-4">None</td></tr>
                    <tr className="bg-cyan-500/[0.06]"><td className="p-4 text-white font-bold">Inaya Network (DePIN)</td><td className="p-4 text-emerald-400 font-bold">4.50 USDT</td><td className="p-4 text-emerald-400 font-bold">10 INAYA</td><td className="p-4 text-emerald-400 font-bold">Zero Constraints</td></tr>
                  </tbody>
                </table>
              </div>

              {activeCorporatePlan && (
                <div className="bg-emerald-500/[0.06] border border-emerald-500/30 rounded-2xl p-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 font-mono text-xs">
                  <div>
                    <span className="text-emerald-400 font-bold">✓ ACTIVE CORPORATE RESERVE:</span>
                    <span className="text-white font-bold ml-2">{activeCorporatePlan.tier}</span>
                    <span className="text-slate-500 ml-2">— valid until {new Date(activeCorporatePlan.expiresAt).toLocaleDateString()}</span>
                  </div>
                  <span className="text-[10px] text-slate-500">Re-purchasing before this date will prompt a duplicate-purchase confirmation.</span>
                </div>
              )}

              {/* CORPORATE RESERVE PLANS TABLE */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 overflow-x-auto">
                <h3 className="text-sm font-bold text-white mb-1">🏢 Corporate Reserve Plans (Annual)</h3>
                <p className="text-[10px] text-slate-500 font-mono mb-4">Fixed annual allocation, billed in USDT, with system maintenance settled natively in INAYA.</p>
                <table className="w-full text-left font-mono text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400 text-[10px] uppercase">
                      <th className="p-4 font-bold">Total Allocated Data</th>
                      <th className="p-4 font-bold">Legacy AWS S3 Cost</th>
                      <th className="p-4 font-bold">Competitor B2 Reserve</th>
                      <th className="p-4 font-bold">Inaya Corporate Storage Fee</th>
                      <th className="p-4 font-bold">Annual Maintenance (INAYA)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-slate-300">
                    <tr className={selectedB2BTier === '250 TB / Year' ? 'bg-cyan-500/[0.04]' : ''}>
                      <td className="p-4 text-white font-bold">250 TB / Year</td>
                      <td className="p-4">76,680 USDT / yr</td>
                      <td className="p-4">19,500 USDT / yr</td>
                      <td className="p-4 text-amber-400 font-bold">13,500 USDT / Year</td>
                      <td className="p-4">500 USDT-equivalent / yr</td>
                    </tr>
                    <tr className={selectedB2BTier === '500 TB / Year' ? 'bg-cyan-500/[0.04]' : ''}>
                      <td className="p-4 text-white font-bold">500 TB / Year</td>
                      <td className="p-4">151,680 USDT / yr</td>
                      <td className="p-4">39,000 USDT / yr</td>
                      <td className="p-4 text-amber-400 font-bold">27,000 USDT / Year</td>
                      <td className="p-4">1,000 USDT-equivalent / yr</td>
                    </tr>
                    <tr className={selectedB2BTier === '1000 TB / Year' ? 'bg-cyan-500/[0.04]' : ''}>
                      <td className="p-4 text-white font-bold">1000 TB / Year</td>
                      <td className="p-4">295,680 USDT / yr</td>
                      <td className="p-4">78,000 USDT / yr</td>
                      <td className="p-4 text-amber-400 font-bold">54,000 USDT / Year</td>
                      <td className="p-4">2,000 USDT-equivalent / yr</td>
                    </tr>
                  </tbody>
                </table>

                {/* LIVE REVENUE ROUTER CHECKOUT TRIGGER */}
                <div className="mt-6 bg-[#0b1224] border border-[#00f2fe]/30 p-6 rounded-2xl flex flex-col md:flex-row justify-between items-center gap-4">
                  <div className="text-left font-mono">
                    <span className="text-[#00f2fe] text-xs font-bold block">// READY FOR ON-CHAIN ACTIVATION</span>
                    <p className="text-sm text-white font-extrabold mt-1">
                      Selected Allocation: <span className="text-amber-400">{selectedB2BTier}</span>
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Billed via trustless multi-shard settlement router.
                    </p>
                  </div>
                  
                  <button
                    onClick={handleCorporateCheckout}
                    disabled={isProcessingInvoice}
                    className="w-full md:w-auto px-8 py-3 bg-gradient-to-r from-emerald-400 to-teal-500 text-[#060913] font-black text-xs rounded-xl shadow-[0_0_15px_rgba(52,211,153,0.2)] hover:brightness-110 active:scale-95 transition-all disabled:opacity-40"
                  >
                    {isProcessingInvoice ? "PROCESSING ORDER..." : `💳 PAY & ACTIVATE ${selectedB2BTier.toUpperCase()}`}
                  </button>
                </div>
              </div>

              {/* PROFESSIONAL NETWORK FUNDAMENTALS */}
              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
                <h3 className="text-sm font-bold text-white mb-4">✅ Professional Network Fundamentals</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-[11px]">
                  <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">Always-Hot Performance Storage</span>
                    <p className="text-slate-500 mt-1">Data shards stay permanently ready for concurrent retrieval — no cold-archive latency gaps.</p>
                  </div>
                  <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">Zero Minimum File Size Penalties</span>
                    <p className="text-slate-500 mt-1">Tiny configs or massive video assets settle under the same uniform rate framework.</p>
                  </div>
                  <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">Zero Storage Duration Constraints</span>
                    <p className="text-slate-500 mt-1">Delete or cycle files freely — no contractual early-termination penalties.</p>
                  </div>
                  <div className="bg-black/20 border border-white/5 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">Free Core API Calls</span>
                    <p className="text-slate-500 mt-1">Configure, query, and monitor storage routes without unexpected micro-charges.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 🥩 VIEWPORT AREA 2B-2: $INAYA STAKING ENGINE */}
          {currentPage === 'Staking' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">$INAYA Staking Engine</h2>
              <p className="text-[#94a3b8] text-sm mb-2">Stake $INAYA to earn passive APY from the 8,000,000 INAYA Staking Rewards Pool and unlock priority bandwidth tiers.</p>

              {stakingLog && (
                <div className="bg-[#0d1527] border border-[#00f2fe]/20 text-[#00f2fe] font-mono text-xs p-4 rounded-xl break-words">
                  {stakingLog}
                </div>
              )}

              {/* OVERVIEW CARDS */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
                <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl">
                  <div className="text-xl font-bold text-white">{Number(stakingOverview.totalStakedTVL).toLocaleString()} INAYA</div>
                  <div className="text-[10px] uppercase text-[#64748b] mt-1">Total Value Locked</div>
                </div>
                <div className="bg-[#0b1120]/40 border-l-4 border-emerald-400 p-5 rounded-r-xl">
                  <div className="text-xl font-bold text-white">{stakingOverview.estimatedAPY}%</div>
                  <div className="text-[10px] uppercase text-[#64748b] mt-1">Estimated APY (Flexible)</div>
                </div>
                <div className="bg-[#0b1120]/40 border-l-4 border-violet-400 p-5 rounded-r-xl">
                  <div className="text-xl font-bold text-white">{Number(stakingOverview.myStakedBalance).toLocaleString()} INAYA</div>
                  <div className="text-[10px] uppercase text-[#64748b] mt-1">My Staked Balance</div>
                </div>
                <div className="bg-[#0b1120]/40 border-l-4 border-amber-400 p-5 rounded-r-xl">
                  <div className="text-xl font-bold text-white">{Number(stakingOverview.claimableRewards).toFixed(4)} INAYA</div>
                  <div className="text-[10px] uppercase text-[#64748b] mt-1">Claimable Rewards</div>
                </div>
              </div>

              {/* ENTERPRISE TIER BADGE */}
              {isConnected && stakingOverview.userTier === 'Enterprise Priority' && (
                <div className="bg-emerald-500/[0.06] border border-emerald-500/30 rounded-2xl p-4 font-mono text-xs flex items-center gap-2">
                  <span className="text-emerald-400 font-bold">⚡ Tier 1 Priority Node — High API Bandwidth Active</span>
                </div>
              )}

              {/* STAKE / UNSTAKE / CLAIM PANELS */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* STAKE PANEL */}
                <div className="bg-[#090d16]/80 border border-[#00f2fe]/20 rounded-2xl p-5 space-y-3 font-mono">
                  <h3 className="text-sm font-bold text-white">📥 Stake</h3>
                  <input
                    type="number" min="0" value={stakeAmountInput}
                    onChange={(e) => setStakeAmountInput(e.target.value)}
                    placeholder="Amount to stake"
                    className="w-full bg-[#060913] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]/40"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    {[{ label: 'Flexible', value: 0 }, { label: '30 Days', value: 30 }, { label: '90 Days', value: 90 }].map((tier) => (
                      <button
                        key={tier.value}
                        onClick={() => setSelectedLockTier(tier.value)}
                        className={`py-1.5 text-[10px] font-bold rounded-lg border transition-all ${selectedLockTier === tier.value ? 'bg-[#00f2fe] text-[#060913] border-[#00f2fe]' : 'bg-black/20 text-slate-400 border-white/10'}`}
                      >
                        {tier.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-slate-500">Flexible = 1.00x · 30 Days = 1.25x · 90 Days = 1.50x reward multiplier.</p>
                  <button
                    onClick={handleStakeInaya}
                    disabled={isStakingBusy || !isConnected}
                    className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-[11px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40"
                  >
                    {isStakingBusy ? "STAKING..." : "⚡ APPROVE & STAKE"}
                  </button>
                </div>

                {/* UNSTAKE PANEL */}
                <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5 space-y-3 font-mono">
                  <h3 className="text-sm font-bold text-white">📤 Unstake</h3>
                  <input
                    type="number" min="0" value={unstakeAmountInput}
                    onChange={(e) => setUnstakeAmountInput(e.target.value)}
                    placeholder="Amount to withdraw"
                    className="w-full bg-[#060913] border border-white/10 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#00f2fe]/40"
                  />
                  {stakingOverview.lockExpiryTimestamp > Date.now() && (
                    <p className="text-[10px] text-amber-400 font-bold">🔒 Locked until {new Date(stakingOverview.lockExpiryTimestamp).toLocaleString()}</p>
                  )}
                  <button
                    onClick={handleUnstakeInaya}
                    disabled={isUnstakingBusy || !isConnected}
                    className="w-full py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold text-[11px] rounded-lg transition-all disabled:opacity-40"
                  >
                    {isUnstakingBusy ? "WITHDRAWING..." : "WITHDRAW"}
                  </button>
                </div>

                {/* CLAIM PANEL */}
                <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-5 space-y-3 font-mono flex flex-col justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-white mb-2">🎁 Claim Rewards</h3>
                    <div className="text-2xl font-extrabold text-emerald-400">{Number(stakingOverview.claimableRewards).toFixed(4)}</div>
                    <div className="text-[10px] text-slate-500">$INAYA available to claim</div>
                  </div>
                  <button
                    onClick={handleClaimStakingReward}
                    disabled={isClaimingBusy || !isConnected || parseFloat(stakingOverview.claimableRewards) <= 0}
                    className="w-full py-2.5 bg-gradient-to-r from-emerald-400 to-teal-500 text-[#060913] font-bold text-[11px] rounded-lg hover:brightness-110 transition-all disabled:opacity-40"
                  >
                    {isClaimingBusy ? "CLAIMING..." : "CLAIM REWARDS"}
                  </button>
                </div>

              </div>
            </div>
          )}

          {/* 📊 VIEWPORT AREA 2C: MY DASHBOARD */}
          {currentPage === 'My Dashboard' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white tracking-tight mb-1">My Dashboard</h2>
              <p className="text-[#94a3b8] text-sm mb-2">A live read of your on-chain billing activity, storage allocation, and total spend across Pay-As-You-Go and Corporate Reserve.</p>

              {!isConnected ? (
                <div className="bg-black/20 border border-white/5 rounded-2xl p-10 text-center font-mono text-xs text-[#64748b] italic">// Connect your wallet to load dashboard data.</div>
              ) : (
                <>
                  {/* SUMMARY CARDS */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono text-xs">
                    <div className="bg-[#0b1120]/40 border-l-4 border-[#00f2fe] p-5 rounded-r-xl">
                      <div className="text-xl font-bold text-white">{totalSpaceAllocatedTB.toLocaleString()} TB</div>
                      <div className="text-[10px] uppercase text-[#64748b] mt-1">Total Space Allocated</div>
                    </div>
                    <div className="bg-[#0b1120]/40 border-l-4 border-emerald-400 p-5 rounded-r-xl">
                      <div className="text-xl font-bold text-white">{paygTotalUsdtSpent.toFixed(4)} USDT</div>
                      <div className="text-[10px] uppercase text-[#64748b] mt-1">Total PAYG Spent (USDT)</div>
                    </div>
                    <div className="bg-[#0b1120]/40 border-l-4 border-violet-400 p-5 rounded-r-xl">
                      <div className="text-xl font-bold text-white">{paygTotalInayaSpent.toFixed(4)} INAYA</div>
                      <div className="text-[10px] uppercase text-[#64748b] mt-1">Total PAYG Spent (INAYA)</div>
                    </div>
                    <div className="bg-[#0b1120]/40 border-l-4 border-amber-400 p-5 rounded-r-xl">
                      <div className="text-xl font-bold text-white">{paygHistory.length}</div>
                      <div className="text-[10px] uppercase text-[#64748b] mt-1">PAYG Transactions Logged</div>
                    </div>
                  </div>

                  {/* STORAGE SPACE ALLOCATION BREAKDOWN */}
                  <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
                    <h3 className="text-sm font-bold text-white mb-4">🗄️ Storage Space Allocation</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-xs">
                      <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                        <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Pay-As-You-Go Commitment</div>
                        <div className="text-white font-bold text-lg">{paygStatus.tbCommitted} TB</div>
                        <div className="mt-1">
                          Storage: {paygStatus.storageActive ? <span className="text-emerald-400 font-bold">ACTIVE</span> : <span className="text-amber-400 font-bold">LAPSED</span>}
                          {paygStatus.storagePaidThrough > 0 && <span className="text-slate-500"> · through {new Date(paygStatus.storagePaidThrough).toLocaleDateString()}</span>}
                        </div>
                      </div>
                      <div className="bg-black/20 border border-white/5 rounded-xl p-4">
                        <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Corporate Reserve Allocation</div>
                        <div className="text-white font-bold text-lg">{corporateAllocatedTB.toLocaleString()} TB</div>
                        <div className="mt-1">
                          {activeCorporatePlan ? (
                            <span className="text-emerald-400 font-bold">{activeCorporatePlan.tier} — valid until {new Date(activeCorporatePlan.expiresAt).toLocaleDateString()}</span>
                          ) : (
                            <span className="text-slate-500">No active Corporate Reserve plan</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* PAYG TRANSACTION HISTORY TABLE */}
                  <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 overflow-x-auto">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-sm font-bold text-white">🧾 Pay-As-You-Go Transactions</h3>
                      <button onClick={() => fetchPaygHistory(walletAddress)} className="text-[10px] font-mono bg-white/5 text-[#00f2fe] border border-white/10 px-3 py-1 rounded-lg hover:bg-white/10 transition-colors">🔄 REFRESH</button>
                    </div>
                    {isLoadingPaygHistory ? (
                      <div className="py-6 text-center font-mono text-xs text-[#64748b]">⚙️ Syncing PAYG ledger events...</div>
                    ) : paygHistory.length === 0 ? (
                      <div className="py-6 text-center font-mono text-xs text-[#64748b] italic">// No Pay-As-You-Go transactions found in the current ledger block window.</div>
                    ) : (
                      <table className="w-full text-left font-mono text-xs border-collapse">
                        <thead>
                          <tr className="border-b border-white/10 bg-white/[0.02] text-slate-400 text-[10px] uppercase">
                            <th className="p-3 font-bold">Type</th>
                            <th className="p-3 font-bold">Units</th>
                            <th className="p-3 font-bold">Amount</th>
                            <th className="p-3 font-bold">Date</th>
                            <th className="p-3 font-bold">Tx</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5 text-slate-300">
                          {paygHistory.map((item, idx) => (
                            <tr key={idx}>
                              <td className="p-3 text-white">{item.type}</td>
                              <td className="p-3">{item.units}</td>
                              <td className="p-3 text-emerald-400 font-bold">{parseFloat(item.amount).toFixed(4)} {item.asset}</td>
                              <td className="p-3">{new Date(item.timestamp).toLocaleDateString()}</td>
                              <td className="p-3">
                                <a href={`https://testnet.bscscan.com/tx/${item.txHash}`} target="_blank" rel="noreferrer" className="text-[#00f2fe] underline">View ↗</a>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* VIEWPORT AREA 3: GENESIS AIRDROP CALCULATOR METRICS */}
          {currentPage === 'Genesis Airdrop' && (
            <div className="max-w-5xl mx-auto space-y-6">
              <h2 className="text-2xl font-extrabold text-white">Genesis Incentivized Portal</h2>
              
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 bg-black/20 p-6 rounded-xl border border-white/5 font-mono text-xs">
                <div>Total Points Weight:<br/><span className="text-[#00f2fe] text-2xl font-bold">{userPoints.total_points} PTS</span></div>
                <div>Shard Points:<br/><span className="text-white text-xl font-bold">{userPoints.dapp_points} PTS</span></div>
                <div>Social Weight:<br/><span className="text-white text-xl font-bold">{userPoints.social_points} PTS</span></div>
              </div>

              <div className="bg-gradient-to-r from-[#0a0f1d] to-[#0b1426] border border-[#00f2fe]/20 rounded-xl p-6 grid grid-cols-1 md:grid-cols-3 gap-6 items-center font-mono text-xs">
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

                <div className="bg-black/30 border border-white/5 rounded-lg p-3.5 flex flex-col justify-center items-center text-center">
                  <span className="text-[#64748b] uppercase text-[10px] mb-1">Estimated Yield Output</span>
                  <div className="text-2xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-[#00f2fe] to-emerald-400">
                    {(userPoints.total_points * 0.0002).toFixed(4)} <span className="text-[10px] font-bold text-emerald-400">$INAYA</span>
                  </div>
                  <span className="text-[9px] text-[#00f2fe]/70 mt-1">✓ Allocation Verified for Host Node</span>
                </div>

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

              <div className="bg-black/40 border border-white/5 p-6 rounded-xl space-y-4">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <div className="text-sm font-bold text-white">Link Social Handle (X / Telegram Link Matrix)</div>
                    <div className="text-xs text-[#94a3b8]">Register community verification markers to scale weights.</div>
                  </div>
                  <div className="flex gap-2 w-full sm:w-auto">
                    <input type="text" value={socialHandle} onChange={(e) => setSocialHandle(e.target.value)} placeholder="@username" className="bg-[#060913] border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-[#00f2fe]/50" />
                    <button onClick={handleSubmitSocial} className="text-xs font-bold bg-[#00f2fe] text-[#060913] px-4 py-2 rounded-lg transition-transform active:scale-95 hover:brightness-110">SUBMIT</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* VIEWPORT AREA 5: WHITE PAPER */}
          {currentPage === 'White Paper' && (
            <div className="max-w-4xl mx-auto bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 space-y-6">
              <h1 className="text-2xl font-black text-white">THE INAYA PROTOCOL</h1>
              <p className="text-xs text-[#94a3b8] font-bold uppercase tracking-wider">A Decentralized Sovereign Custody Network for High-Value Assets</p>
              
              <div className="flex flex-wrap gap-2 border-b border-white/5 pb-3">
                {['Abstract', 'The Problem', 'Architecture', 'Tokenomics Matrix'].map((sec) => (
                  <button key={sec} onClick={() => setActivePaperSection(sec)} className={`px-4 py-2 text-xs font-mono font-bold rounded-lg transition-all ${activePaperSection === sec ? 'bg-[#00f2fe]/10 border border-[#00f2fe] text-[#00f2fe]' : 'text-[#64748b] bg-white/[0.01] hover:text-slate-300'}`}>{sec}</button>
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
                    <p className="text-[10px] text-slate-500 italic font-mono -mt-2">Verified against the Strategic Business Model &amp; Financial Architecture (INAYA-EXEC-2026-V1).</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center pt-2">
                      
                      <div className="w-full border border-white/10 bg-[#060913] rounded-xl p-5 flex flex-col justify-center space-y-4">
                        <span className="text-[10px] font-mono text-[#64748b] uppercase tracking-widest">Visual Asset Weight Distribution</span>
                        
                        <div className="w-full h-8 rounded-lg overflow-hidden flex border border-white/5 shadow-inner">
                          <div className="bg-[#4facfe] h-full transition-all" style={{ width: '40.0%' }} title="Swarm Reserve: 40.0%"></div>
                          <div className="bg-violet-500 h-full transition-all" style={{ width: '26.7%' }} title="Staking Rewards: 26.7%"></div>
                          <div className="bg-cyan-400 h-full transition-all" style={{ width: '21.7%' }} title="Liquidity Pool: 21.7%"></div>
                          <div className="bg-indigo-500 h-full transition-all" style={{ width: '5.0%' }} title="Team Runway: 5.0%"></div>
                          <div className="bg-amber-400 h-full transition-all" style={{ width: '3.3%' }} title="Ecosystem Fund: 3.3%"></div>
                          <div className="bg-emerald-400 h-full transition-all" style={{ width: '3.3%' }} title="Genesis Airdrop: 3.3%"></div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 font-mono text-[9px]">
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-[#4facfe]"></span> <span className="text-slate-400">Swarm Reserve (40.0%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-violet-500"></span> <span className="text-slate-400">Staking Rewards (26.7%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-cyan-400"></span> <span className="text-slate-400">Liquidity (21.7%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-indigo-500"></span> <span className="text-slate-400">Team Core (5.0%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-amber-400"></span> <span className="text-slate-400">Ecosystem Fund (3.3%)</span></div>
                          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-emerald-400"></span> <span className="text-slate-400">Airdrop (3.3%)</span></div>
                        </div>
                      </div>

                      <div className="font-mono text-xs space-y-3">
                        <div className="text-white font-bold bg-white/5 p-2 rounded border border-white/5">Total Hard Cap: 30,000,000 $INAYA</div>
                        <div className="space-y-1 text-[#94a3b8]">
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>🛸 Swarm Reserve (Strategic/Nodes):</span><span className="text-[#4facfe] font-bold">40.0% (12M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>🥩 Staking Rewards Pool:</span><span className="text-violet-400 font-bold">26.7% (8M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>💧 Liquidity Pool Allocation:</span><span className="text-cyan-400 font-bold">21.7% (6.5M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>👥 Team Runway Core:</span><span className="text-indigo-400 font-bold">5.0% (1.5M)</span></div>
                          <div className="flex justify-between border-b border-white/5 pb-1"><span>🌱 Ecosystem Fund:</span><span className="text-amber-400 font-bold">3.3% (1M)</span></div>
                          <div className="flex justify-between"><span>🎁 Genesis Airdrop Portals:</span><span className="text-emerald-400 font-bold">3.3% (1M)</span></div>
                        </div>
                        <p className="text-[9px] text-slate-600 pt-1 italic">Figures reconciled directly against the verified $INAYA token contract allocations on BNB Testnet.</p>
                      </div>

                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* VIEWPORT AREA 6: CORPORATE DETAILED ABOUT US SHEET */}
          {currentPage === 'About Us' && (
            <div className="max-w-5xl mx-auto space-y-8">
              
              <div className="bg-[#090d16]/80 border border-[#00f2fe]/20 rounded-2xl p-6 backdrop-blur-md shadow-xl space-y-4">
                <h3 className="text-lg font-extrabold text-white tracking-wide border-b border-white/5 pb-2">🛡️ OUR ARCHITECTURAL MISSION</h3>
                <p className="text-sm text-[#94a3b8] font-mono leading-relaxed">
                  The primary objective of the Inaya Network is to re-establish absolute data sovereignty directly at the client-side execution layer. By eliminating institutional intermediaries and systemic runtime vectors, we empower edge-node operators with uncompromised asset management control.
                </p>
                <p className="text-sm text-[#94a3b8] font-mono leading-relaxed">
                  Our protocol uses client-side cryptographic sharding backed by PBKDF2 key derivation and AES-GCM encryption. Files are encrypted and split into independent fragments before they ever leave the browser — no single node, server, or administrator holds a complete, decryptable copy of your data.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[11px] font-mono pt-2">
                  <div className="bg-black/40 border border-cyan-500/20 p-4 rounded-xl">
                    <span className="text-[#00f2fe] font-bold">✓ Client-Side Encrypted:</span>
                    <p className="text-slate-500 mt-1">Files are encrypted locally before upload. Plaintext never traverses the network pipelines intact.</p>
                  </div>
                  <div className="bg-black/40 border border-emerald-500/20 p-4 rounded-xl">
                    <span className="text-emerald-400 font-bold">✓ Decentralized Immutable Anchoring:</span>
                    <p className="text-slate-500 mt-1">State variables are locked into EVM registers on the BNB Chain, maintaining bulletproof transactional lineage tracking.</p>
                  </div>
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-5">👤 EXECUTIVE LEADERSHIP &amp; FOUNDER MATRIX</h3>
                <div className="space-y-4">

                  <div className="border border-[#00f2fe]/20 bg-black/20 rounded-xl p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <span className="text-white font-bold text-base">Talha Waqas</span>
                      <span className="text-[9px] font-bold text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 px-2.5 py-1 rounded-full uppercase tracking-wide">Founder &amp; CTO</span>
                    </div>
                    <p className="text-[11px] text-slate-500 italic font-mono mb-3">Core System Architect, Smart Contract Architect &amp; Lead Web3 Full-Stack Engineer</p>
                    <div className="text-[9px] font-bold text-amber-400/80 uppercase tracking-widest mb-1.5">Professional Expertise</div>
                    <p className="text-xs text-[#94a3b8] font-mono leading-relaxed">
                      Deep specialization in browser-layer cryptographic engineering, EVM smart contract architecture, client-side encrypted storage protocols, and node telemetry networks. Leads technical execution of the decentralized storage kernels, automated gas estimation pipelines, and public ledger sync operations — along with core codebase development and security parameter optimization for the Inaya stack.
                    </p>
                  </div>

                  <div className="border border-white/10 bg-black/20 rounded-xl p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <span className="text-white font-bold text-base">Fibha Urooj</span>
                      <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-2.5 py-1 rounded-full uppercase tracking-wide">Co-Founder &amp; CMO</span>
                    </div>
                    <p className="text-[11px] text-slate-500 italic font-mono mb-3">Corporate Operations Director, Head of Ecosystem Growth &amp; Lead User Acquisition Strategist</p>
                    <div className="text-[9px] font-bold text-amber-400/80 uppercase tracking-widest mb-1.5">Professional Expertise</div>
                    <p className="text-xs text-[#94a3b8] font-mono leading-relaxed">
                      Strong foundation in commercial finance and asset tracking analysis (B.Com), paired with a background in educational program management. Converts technical cryptography concepts into simplified, mass-market onboarding. Directly manages alpha testing recruitment, ecosystem marketing funnels, community rewards tracking (Zealy / QuestN), and cross-regional tester education.
                    </p>
                  </div>

                </div>
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
                <h3 className="text-base font-bold text-white mb-4">📚 OFFICIAL DOCUMENTS &amp; RESOURCES</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {documentsList.map((doc) => (
                    <a
                      key={doc.href}
                      href={doc.href}
                      target="_blank"
                      rel="noreferrer"
                      className="group bg-black/20 border border-white/5 hover:border-[#00f2fe]/50 p-4 rounded-xl flex items-start gap-3 transition-all hover:bg-white/[0.02]"
                    >
                      <span className="text-xl leading-none mt-0.5">{doc.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-white group-hover:text-[#00f2fe] transition-colors">
                          {doc.title}
                        </div>
                        <p className="text-[11px] text-[#64748b] font-mono mt-1 leading-relaxed">
                          {doc.desc}
                        </p>
                        <span className="inline-block mt-2 text-[10px] font-mono font-bold text-[#00f2fe]">
                          VIEW / DOWNLOAD PDF →
                        </span>
                      </div>
                    </a>
                  ))}
                </div>
              </div>

              <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6 backdrop-blur-md">
                <h3 className="text-base font-bold text-white mb-4">🌐 LIVE NETWORKS INTERFACE ENDPOINTS</h3>
                <div className="flex flex-col sm:flex-row gap-4 font-mono text-xs text-[#00f2fe]">
                  <a href="https://t.me/inayanetwork" target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe] transition-all py-3 block">Telegram Swarm Hub 🚀</a>
                  <a href="https://x.com/InayaNetwork" target="_blank" rel="noreferrer" className="bg-black/20 p-4 rounded-xl border border-white/5 flex-1 text-center hover:border-[#00f2fe] transition-all py-3 block">X Network Telemetry 🐦</a>
                </div>
              </div>

              <div className="bg-black/20 border border-white/5 rounded-2xl p-5 font-mono text-[10px] text-[#64748b] leading-relaxed">
                <p className="mb-2"><span className="text-amber-400/80 font-bold">⚠ Deployment Status:</span> Inaya Network is currently deployed on BNB Chain Testnet only. No mainnet funds, tokens, or production data should be used with this interface.</p>
                <p>By connecting a wallet, you acknowledge that Genesis Airdrop points earned during the testnet phase will convert into $INAYA mainnet token allocations at TGE, subject to the program's eligibility criteria and anti-sybil verification requirements. Wallet addresses and social handles submitted are used solely for ecosystem contribution tracking.</p>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* OVERLAY MODAL FOR CONNECT PROVIDERS */}
      {isWalletModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-[9999]">
          <div className="bg-[#090e1a] border border-[#00f2fe]/20 w-full max-w-sm rounded-2xl p-6 relative">
            <button onClick={() => setIsWalletModalOpen(false)} className="absolute top-4 right-4 text-[#64748b] font-mono hover:text-white">✕</button>
            <div className="text-center mb-5"><h3 className="text-white font-bold">Select Gateway Access</h3></div>
            <div className="space-y-2">
              {['MetaMask', 'Trust Wallet', 'Coinbase Wallet', 'WalletConnect'].map((w) => (
                <button key={w} onClick={() => connectTargetWallet(w)} className="w-full bg-white/[0.02] border border-white/5 hover:border-[#00f2fe] p-3.5 text-left rounded-xl text-xs text-white font-bold transition-all hover:bg-white/5">{w}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
