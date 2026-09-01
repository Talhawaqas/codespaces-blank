"use client";

// /bridge -- cross-chain $INAYA transfer + unified staking position (SOW-1).
//
// Deliberately a new, isolated route rather than extending the already ~7500-line src/app/page.js
// -- keeps the existing staking tab's byte-for-byte-unchanged behavior completely untouched.
// See CROSS_CHAIN_BRIDGE_GUIDE.md for the full architecture.

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { PublicKey } from "@solana/web3.js";
import { CHAINS, CHAIN_IDS, SOLANA_DEVNET_CHAIN_ID, ensureChain, getChain } from "@/lib/chains";
import SolanaBridgePanel from "@/components/bridge/SolanaBridgePanel";
import AddressRiskCheck from "@/components/AddressRiskCheck";

const BRIDGE_HOME_ABI = [
  "function bridgeOut(uint256 destChainId, bytes32 recipient, uint256 amount) external returns (bytes32 messageId)",
];
const BRIDGE_SPOKE_ABI = [
  "function bridgeToHome(bytes32 recipient, uint256 amount) external returns (bytes32 messageId)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];
const MESSENGER_SENT_TOPIC_ABI = [
  "event MessageSent(bytes32 indexed messageId, tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message)",
];

const TRANSFER_FEE = 100000000000000n; // 0.0001 INAYA -- InayaToken's flat fee, home side only

// Interop SOW -- every route below is REAL and PROVEN (docs/inaya-interoperability.md's
// Definition of Done): a real attestation + wrapped-token creation + locked transfer +
// completed transfer + non-zero destination balance, each verified on-chain. Every chain ID
// here is the chain's OWN Wormhole-registered testnet ID, not assumed from its mainnet family
// (Sepolia=10002, ArbitrumSepolia=10003 -- NOT 2/23, mainnet Ethereum/Arbitrum's IDs -- a real
// bug found and fixed this session). See
// deployments/interop/wormhole-wtt/bscTestnet-attestation.json for every transaction hash.
const WORMHOLE_BSC_TOKEN_BRIDGE = "0x9dcF9D205C9De35334D646BeE44b2D2859712A09";
const WORMHOLE_PROVEN_DESTINATIONS = [
  { key: "ETHEREUM", label: "Ethereum (Sepolia)", wormholeChainId: 10002 },
  { key: "ARBITRUM", label: "Arbitrum (Sepolia)", wormholeChainId: 10003 },
  { key: "AVALANCHE", label: "Avalanche (Fuji)", wormholeChainId: 6 },
];
const WORMHOLE_TRANSFER_TOKENS_ABI = ["function transferTokens(address,uint256,uint16,bytes32,uint256,uint32) payable returns (uint64)"];

function getBrowserProvider() {
  if (typeof window === "undefined" || !window.ethereum) return null;
  return new ethers.BrowserProvider(window.ethereum);
}

export default function BridgePage() {
  const [chains, setChains] = useState([]);
  const [sourceChainId, setSourceChainId] = useState(CHAIN_IDS.BSC_TESTNET);
  const [destChainId, setDestChainId] = useState(CHAIN_IDS.SEPOLIA);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [account, setAccount] = useState(null);
  const [status, setStatus] = useState("");
  const [messageHash, setMessageHash] = useState(null);
  const [transferStatus, setTransferStatus] = useState(null);
  const [position, setPosition] = useState(null);

  // Interop SOW state -- deliberately separate from the native-bridge state above, since it's
  // a different system (src/lib/interopTransfers.js's interop_transfers, not bridge_transfers).
  const [interopChains, setInteropChains] = useState(null);
  const [interopDest, setInteropDest] = useState(WORMHOLE_PROVEN_DESTINATIONS[0].key);
  const [interopAmount, setInteropAmount] = useState("");
  const [interopStatus, setInteropStatus] = useState("");
  const [interopTransferId, setInteropTransferId] = useState(null);
  const [interopTransfer, setInteropTransfer] = useState(null);

  useEffect(() => {
    fetch("/api/interop/supported-chains")
      .then((r) => r.json())
      .then((d) => d.success && setInteropChains(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!interopTransferId) return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/interop/wtt/status/${interopTransferId}`);
      const data = await res.json();
      if (data.success) {
        setInteropTransfer(data.transfer);
        if (data.transfer.status === "COMPLETED" || data.transfer.status === "FAILED") clearInterval(interval);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [interopTransferId]);

  async function handleInteropTransfer() {
    try {
      setInteropStatus("Preparing Wormhole transfer...");
      const provider = getBrowserProvider();
      if (!provider) throw new Error("No wallet");
      await ensureChain(window.ethereum, CHAIN_IDS.BSC_TESTNET);

      const signer = await provider.getSigner();
      const amountWei = ethers.parseUnits(interopAmount || "0", 18);
      if (amountWei <= 0n) throw new Error("Enter an amount");

      const home = getChain(CHAIN_IDS.BSC_TESTNET);
      const token = new ethers.Contract(home.contracts.inayaToken, ERC20_ABI, signer);
      setInteropStatus("Approving Wormhole Token Bridge...");
      await (await token.approve(WORMHOLE_BSC_TOKEN_BRIDGE, amountWei)).wait();

      const dest = WORMHOLE_PROVEN_DESTINATIONS.find((d) => d.key === interopDest);
      const tb = new ethers.Contract(WORMHOLE_BSC_TOKEN_BRIDGE, WORMHOLE_TRANSFER_TOKENS_ABI, signer);
      const recipientBytes32 = ethers.zeroPadValue(account, 32);
      const nonce = Math.floor(Math.random() * 1e9);
      setInteropStatus(`Locking $INAYA on BSC via Wormhole, destined for ${dest.label}...`);
      const tx = await tb.transferTokens(home.contracts.inayaToken, amountWei, dest.wormholeChainId, recipientBytes32, 0, nonce);
      const receipt = await tx.wait();

      const initRes = await fetch("/api/interop/wtt/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceChain: "BSC", destChain: dest.key, sourceTxHash: receipt.hash, userAddress: account, amount: amountWei.toString() }),
      });
      const initData = await initRes.json();
      if (!initData.success) throw new Error(initData.error || "Failed to record transfer");

      setInteropTransferId(initData.transferId);
      setInteropStatus(`Locked on BSC (${receipt.hash.slice(0, 10)}...). Waiting for Wormhole Guardian attestation + relay to ${dest.label} -- this can take a few minutes.`);
    } catch (err) {
      setInteropStatus(`Error: ${err.message}`);
    }
  }

  useEffect(() => {
    fetch("/api/bridge/supported-chains")
      .then((r) => r.json())
      .then((d) => d.success && setChains(d.chains))
      .catch(() => {});
  }, []);

  const connect = useCallback(async () => {
    const provider = getBrowserProvider();
    if (!provider) {
      setStatus("No injected wallet found (MetaMask etc.)");
      return;
    }
    const accounts = await provider.send("eth_requestAccounts", []);
    setAccount(accounts[0]);
    setRecipient((r) => r || accounts[0]);
  }, []);

  const refreshPosition = useCallback(async (address) => {
    if (!address) return;
    const res = await fetch(`/api/bridge/staking-position/${address}`);
    const data = await res.json();
    if (data.success) setPosition(data.position);
  }, []);

  useEffect(() => {
    if (account) refreshPosition(account);
  }, [account, refreshPosition]);

  // Poll transfer status once we have a messageHash.
  useEffect(() => {
    if (!messageHash) return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/bridge/transfer-status/${messageHash}`);
      const data = await res.json();
      if (data.success) {
        setTransferStatus(data.transfer);
        if (data.transfer.status === "completed" || data.transfer.status === "failed") {
          clearInterval(interval);
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [messageHash]);

  async function handleTransfer() {
    try {
      setStatus("Preparing transfer...");
      const provider = getBrowserProvider();
      if (!provider) throw new Error("No wallet");
      await ensureChain(window.ethereum, sourceChainId);

      const signer = await provider.getSigner();
      const source = getChain(sourceChainId);
      const isHome = source.isHome;
      const amountWei = ethers.parseUnits(amount || "0", 18);
      if (amountWei <= 0n) throw new Error("Enter an amount");

      const recipientBytes32 =
        destChainId === SOLANA_DEVNET_CHAIN_ID
          ? ethers.hexlify(new PublicKey(recipient).toBytes())
          : ethers.zeroPadValue(recipient, 32);
      let tx;

      if (isHome) {
        const token = new ethers.Contract(source.contracts.inayaToken, ERC20_ABI, signer);
        setStatus("Approving...");
        await (await token.approve(source.contracts.bridge, amountWei + TRANSFER_FEE)).wait();
        const bridge = new ethers.Contract(source.contracts.bridge, BRIDGE_HOME_ABI, signer);
        setStatus("Bridging out...");
        tx = await bridge.bridgeOut(destChainId, recipientBytes32, amountWei);
      } else {
        const bridge = new ethers.Contract(source.contracts.bridge, BRIDGE_SPOKE_ABI, signer);
        setStatus("Bridging to home...");
        tx = await bridge.bridgeToHome(recipientBytes32, amountWei);
      }

      const receipt = await tx.wait();
      const iface = new ethers.Interface(MESSENGER_SENT_TOPIC_ABI);
      const sentEvent = receipt.logs
        .map((l) => { try { return iface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "MessageSent");
      if (!sentEvent) throw new Error("MessageSent event not found in receipt");

      const hash = sentEvent.args.messageId;
      await fetch("/api/bridge/initiate-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageHash: hash,
          sourceChainId,
          destChainId,
          amount: amountWei.toString(),
          userAddress: account,
          sourceTxHash: tx.hash,
          message: {
            sourceChainId: sentEvent.args.message.sourceChainId.toString(),
            sourceContract: sentEvent.args.message.sourceContract,
            destChainId: sentEvent.args.message.destChainId.toString(),
            destContract: sentEvent.args.message.destContract,
            nonce: sentEvent.args.message.nonce.toString(),
            msgType: sentEvent.args.message.msgType,
            payload: sentEvent.args.message.payload,
          },
        }),
      });

      setMessageHash(hash);
      setStatus(`Submitted. Tracking messageHash ${hash.slice(0, 10)}...`);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  return (
    <div style={{ maxWidth: 640, margin: "40px auto", padding: 24, fontFamily: "sans-serif" }}>
      <h1>Cross-Chain Bridge</h1>
      <p style={{ color: "#666" }}>Move $INAYA between supported networks. Same token everywhere.</p>

      {!account ? (
        <button onClick={connect}>Connect Wallet</button>
      ) : (
        <p>Connected: {account}</p>
      )}

      <div style={{ display: "grid", gap: 12, marginTop: 24 }}>
        <label>
          From
          <select value={sourceChainId} onChange={(e) => setSourceChainId(Number(e.target.value))}>
            {chains.filter((c) => c.isEvm !== false).map((c) => (
              <option key={c.chainId} value={c.chainId}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          To
          <select value={destChainId} onChange={(e) => setDestChainId(Number(e.target.value))}>
            {chains.map((c) => (
              <option key={c.chainId} value={c.chainId}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          Amount (INAYA)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
        </label>
        <label>
          Recipient address
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={destChainId === SOLANA_DEVNET_CHAIN_ID ? "Solana base58 address..." : "0x..."}
          />
          <AddressRiskCheck address={recipient} />
        </label>
        <button onClick={handleTransfer} disabled={!account}>
          Bridge
        </button>
        {status && <p>{status}</p>}
        {transferStatus && (
          <div style={{ border: "1px solid #ddd", padding: 12 }}>
            <strong>Status:</strong> {transferStatus.status}
            {transferStatus.destTxHash && <div>Dest tx: {transferStatus.destTxHash}</div>}
            {transferStatus.failureReason && <div>Reason: {transferStatus.failureReason}</div>}
          </div>
        )}
      </div>

      <SolanaBridgePanel evmRecipientDefault={account} />

      <div style={{ marginTop: 32, borderTop: "1px solid #ddd", paddingTop: 24 }}>
        <h2>Wormhole Interop Layer</h2>
        <p style={{ color: "#666", fontSize: 14 }}>
          Inaya's interoperability layer, built on Wormhole. Not the same system as the bridge above --{" "}
          <a href="/docs/inaya-interoperability" style={{ color: "#666" }}>see the architecture doc</a>. Only routes actually proven
          end-to-end are offered here; everything else is shown as reference only, per Inaya's own
          no-fake-chain-support policy.
        </p>

        <div style={{ display: "grid", gap: 12, marginTop: 16, maxWidth: 420 }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12 }}>
            <strong>BSC → {WORMHOLE_PROVEN_DESTINATIONS.find((d) => d.key === interopDest)?.label}</strong>{" "}
            <span style={{ color: "#0a7", fontSize: 12 }}>● Real, proven route</span>
            <p style={{ fontSize: 12, color: "#666", margin: "4px 0 12px" }}>
              Locks $INAYA on BSC via Wormhole's Token Bridge; Inaya's relayer completes the mint on the destination automatically
              once the Guardian network signs the attestation (a few minutes on testnet).
            </p>
            <label>
              Destination
              <select value={interopDest} onChange={(e) => setInteropDest(e.target.value)}>
                {WORMHOLE_PROVEN_DESTINATIONS.map((d) => (
                  <option key={d.key} value={d.key}>{d.label}</option>
                ))}
              </select>
            </label>
            <label>
              Amount (INAYA)
              <input value={interopAmount} onChange={(e) => setInteropAmount(e.target.value)} placeholder="0.0" />
            </label>
            <button onClick={handleInteropTransfer} disabled={!account} style={{ marginTop: 8 }}>
              Send via Wormhole
            </button>
            {interopStatus && <p style={{ fontSize: 13 }}>{interopStatus}</p>}
            {interopTransfer && (
              <div style={{ border: "1px solid #ddd", padding: 10, marginTop: 8, fontSize: 13 }}>
                <strong>Status:</strong> {interopTransfer.status}
                {interopTransfer.destTxHash && <div>Destination tx: {interopTransfer.destTxHash}</div>}
                {interopTransfer.failureReason && <div>Reason: {interopTransfer.failureReason}</div>}
              </div>
            )}
          </div>

          {interopChains && (
            <details style={{ fontSize: 12, color: "#666" }}>
              <summary style={{ cursor: "pointer" }}>Other networks Wormhole reaches (not yet transfer-ready through Inaya)</summary>
              <ul style={{ marginTop: 8 }}>
                {interopChains.capability
                  .filter((c) => !WORMHOLE_PROVEN_DESTINATIONS.some((d) => d.key === c.key) && c.key !== "BSC")
                  .map((c) => (
                    <li key={c.key}>
                      {c.label}: {c.levelLabel} {c.tier === "D" ? "— not currently reachable via Wormhole for Inaya's actual testnet" : ""}
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {position && (
        <div style={{ marginTop: 32 }}>
          <h2>Your Unified Staking Position</h2>
          <p>Staked: {ethers.formatUnits(position.userStakedBalance, 18)} INAYA</p>
          <p>Claimable rewards: {ethers.formatUnits(position.earned, 18)} INAYA</p>
          <h3>By origin network (lifetime, analytics only)</h3>
          <ul>
            {position.byOriginChain.map((b) => (
              <li key={b.chainId}>
                {getChain(b.chainId)?.name || `Chain ${b.chainId}`}: {ethers.formatUnits(b.lifetimeStaked, 18)} INAYA
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
