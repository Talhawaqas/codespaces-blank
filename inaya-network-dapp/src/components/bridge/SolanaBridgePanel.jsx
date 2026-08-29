"use client";

// Real Solana devnet panel: connect Phantom/Solflare, burn bridged $INAYA on the deployed
// program (76KGt54jrh142nibdFH9BtZHxSu68rrDwxCTp5d98kZn) and notify BSC Testnet (home) to
// unlock to an EVM recipient. Counterpart to page.js's EVM-side bridgeOut/bridgeToHome --
// see solana/programs/inaya-bridge-solana/src/instructions/bridge_to_home.rs.

import { useState, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { ethers } from "ethers";
import idl from "@/lib/solana-idl.json";

const SolanaWalletProviders = dynamic(() => import("./SolanaWalletProviders"), { ssr: false });
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

const PROGRAM_ID = new PublicKey("76KGt54jrh142nibdFH9BtZHxSu68rrDwxCTp5d98kZn");

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

function evmAddressToBytes32Array(address) {
  return Array.from(ethers.getBytes(ethers.zeroPadValue(address, 32)));
}

function PanelInner({ defaultRecipient }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [amount, setAmount] = useState("");
  const [evmRecipient, setEvmRecipient] = useState(defaultRecipient || "");
  const [status, setStatus] = useState("");

  const program = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    return new anchor.Program(idl, provider);
  }, [connection, wallet]);

  const bridgeToHome = useCallback(async () => {
    try {
      if (!program || !wallet.publicKey) throw new Error("Connect a Solana wallet first");
      if (!ethers.isAddress(evmRecipient)) throw new Error("Enter a valid BSC Testnet (0x...) recipient address");
      const amountEvm18 = ethers.parseUnits(amount || "0", 18);
      if (amountEvm18 <= 0n) throw new Error("Enter an amount");

      setStatus("Bridging to BSC Testnet (home)...");
      const mint = pda([Buffer.from("bridged_inaya_mint")]);
      const bridgeConfig = pda([Buffer.from("bridge_config")]);
      const outboundNonceCounter = pda([Buffer.from("outbound_nonce")]);
      const userTokenAccount = getAssociatedTokenAddressSync(mint, wallet.publicKey);

      const sig = await program.methods
        .bridgeToHome(evmAddressToBytes32Array(evmRecipient), new BN(amountEvm18.toString()), new BN(0))
        .accounts({
          user: wallet.publicKey,
          userTokenAccount,
          mint,
          bridgeConfig,
          outboundNonceCounter,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      setStatus(`Submitted: ${sig}. The relayer cron will pick this up and unlock $INAYA to ${evmRecipient} on BSC Testnet.`);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }, [program, wallet.publicKey, amount, evmRecipient]);

  return (
    <div style={{ marginTop: 24, border: "1px solid #ddd", padding: 16, borderRadius: 8 }}>
      <h3 style={{ marginTop: 0 }}>Bridge from Solana Devnet</h3>
      <p style={{ color: "#666", fontSize: 14 }}>
        Sends bridged $INAYA held on Solana back to BSC Testnet (home). To get bridged $INAYA onto
        Solana first, use the form above: From = an EVM chain, To = Solana Devnet, Recipient = your
        Solana wallet address.
      </p>
      <div style={{ marginBottom: 12 }}>
        <WalletMultiButton />
      </div>
      {wallet.publicKey && (
        <div style={{ display: "grid", gap: 12 }}>
          <label>
            Amount (INAYA)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
          </label>
          <label>
            BSC Testnet recipient (0x...)
            <input value={evmRecipient} onChange={(e) => setEvmRecipient(e.target.value)} placeholder="0x..." />
          </label>
          <button onClick={bridgeToHome}>Bridge to BSC Testnet</button>
        </div>
      )}
      {status && <p style={{ wordBreak: "break-all" }}>{status}</p>}
    </div>
  );
}

export default function SolanaBridgePanel({ evmRecipientDefault }) {
  return (
    <SolanaWalletProviders>
      <PanelInner defaultRecipient={evmRecipientDefault} />
    </SolanaWalletProviders>
  );
}
