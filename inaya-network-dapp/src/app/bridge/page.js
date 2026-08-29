"use client";

// /bridge -- cross-chain $INAYA transfer + unified staking position (SOW-1).
//
// Deliberately a new, isolated route rather than extending the already ~7500-line src/app/page.js
// -- keeps the existing staking tab's byte-for-byte-unchanged behavior completely untouched.
// See CROSS_CHAIN_BRIDGE_GUIDE.md for the full architecture.

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { CHAINS, CHAIN_IDS, SOLANA_DEVNET_CHAIN_ID, ensureChain, getChain } from "@/lib/chains";

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

      const recipientBytes32 = ethers.zeroPadValue(recipient, 32);
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
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x..." />
        </label>
        <button onClick={handleTransfer} disabled={!account || destChainId === SOLANA_DEVNET_CHAIN_ID}>
          Bridge
        </button>
        {destChainId === SOLANA_DEVNET_CHAIN_ID && (
          <p style={{ color: "#a60" }}>Solana bridging needs a Phantom/Solflare-connected panel -- not wired into this form yet.</p>
        )}
        {status && <p>{status}</p>}
        {transferStatus && (
          <div style={{ border: "1px solid #ddd", padding: 12 }}>
            <strong>Status:</strong> {transferStatus.status}
            {transferStatus.destTxHash && <div>Dest tx: {transferStatus.destTxHash}</div>}
            {transferStatus.failureReason && <div>Reason: {transferStatus.failureReason}</div>}
          </div>
        )}
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
