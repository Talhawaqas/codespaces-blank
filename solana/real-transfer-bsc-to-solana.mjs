// solana/real-transfer-bsc-to-solana.mjs
//
// Real end-to-end proof for Inaya's OWN native bridge, BSC -> Solana Devnet direction --
// the one leg the deployment notes explicitly flagged as "no end-to-end message send+execute
// proven yet." Not Wormhole -- this is Inaya's own Anchor program, fully in Inaya's control.
//
// Run from repo root: node solana/real-transfer-bsc-to-solana.mjs

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair, Transaction, Secp256k1Program, sendAndConfirmTransaction } from "@solana/web3.js";
import { ethers } from "ethers";
import BN from "bn.js";
import fs from "fs";
import dotenv from "dotenv";

const ROOT = "D:/Codespace-blank/codespaces-blank-main/codespaces-blank-main";
const PROGRAM_ID = new PublicKey("76KGt54jrh142nibdFH9BtZHxSu68rrDwxCTp5d98kZn");
const SOLANA_DEVNET_CHAIN_ID = 1_000_000_002n;
const BSC_CHAIN_ID = 97;

dotenv.config({ path: `${ROOT}/.env` });
dotenv.config({ path: `${ROOT}/inaya-network-dapp/.env.local` });

const homeDeployment = JSON.parse(fs.readFileSync(`${ROOT}/deployments/bridge/bscTestnet.json`, "utf8"));

async function main() {
  // --- Step 1: real bridgeOut() on BSC, destined for Solana ---
  const bscProvider = new ethers.JsonRpcProvider("https://data-seed-prebsc-1-s1.binance.org:8545/", 97, { staticNetwork: true });
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, bscProvider);

  const solanaKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(`${ROOT}/solana/devnet-id.json`, "utf8"))));
  console.log("Solana recipient:", solanaKeypair.publicKey.toBase58());

  const amount = ethers.parseEther("1");
  const fee = 100000000000000n;
  const token = new ethers.Contract(homeDeployment.inayaToken, ["function approve(address,uint256) returns (bool)"], deployer);
  console.log("Approving BSC bridge...");
  await (await token.approve(homeDeployment.bridge, amount + fee)).wait();

  const bridgeAbi = ["function bridgeOut(uint256 destChainId, bytes32 recipient, uint256 amount) external returns (bytes32 messageId)"];
  const bridge = new ethers.Contract(homeDeployment.bridge, bridgeAbi, deployer);
  const recipientBytes32 = ethers.hexlify(solanaKeypair.publicKey.toBytes());
  console.log("Bridging 1 INAYA from BSC to Solana Devnet...");
  const tx = await bridge.bridgeOut(SOLANA_DEVNET_CHAIN_ID, recipientBytes32, amount);
  const receipt = await tx.wait();
  console.log("bridgeOut tx:", receipt.hash, "status:", receipt.status);

  const iface = new ethers.Interface([
    "event MessageSent(bytes32 indexed messageId, tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message)",
  ]);
  const sentEvent = receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MessageSent");
  const messageId = sentEvent.args.messageId; // == message_hash on the Solana side, identical scheme
  const m = sentEvent.args.message;
  console.log("messageId (== message_hash):", messageId);

  // --- Step 2: collect 2 real validator ECDSA signatures over the RAW hash (no EIP-191 prefix --
  // the Solana program compares against the raw digest, unlike the EVM messenger's toEthSignedMessageHash) ---
  const validatorKeys = [process.env.BRIDGE_VALIDATOR_PRIVATE_KEY_1, process.env.BRIDGE_VALIDATOR_PRIVATE_KEY_2].filter(Boolean);
  if (validatorKeys.length < 2) throw new Error("Need at least 2 BRIDGE_VALIDATOR_PRIVATE_KEY_* in inaya-network-dapp/.env.local");

  const hashBytes = ethers.getBytes(messageId);
  // Solana's native secp256k1 precompile keccak256-hashes the instruction's "message" field
  // internally before recovering the signature (confirmed empirically -- undocumented in the
  // client crate's public docs). Our Rust program's own comparison (parse_secp256k1_instruction
  // vs. message_hash(&message)) expects the RAW hash in that field, so the message field stays
  // the raw hash unchanged -- the validators sign keccak256(hash) instead, one extra hash.
  const doubleHash = ethers.keccak256(hashBytes);
  const sigs = validatorKeys.map((k) => {
    const wallet = new ethers.Wallet(k);
    const sig = wallet.signingKey.sign(doubleHash);
    return {
      ethAddress: ethers.getBytes(wallet.address),
      signature: ethers.getBytes(ethers.concat([sig.r, sig.s])),
      recoveryId: sig.yParity, // 0 or 1
    };
  });
  console.log("Validator signers:", sigs.map((s) => ethers.hexlify(s.ethAddress)));

  // --- Step 3: build the Solana transaction: [secp1, secp2, receive_message] ---
  const secretKey = new Uint8Array(JSON.parse(fs.readFileSync(`${ROOT}/solana/devnet-id.json`, "utf8")));
  const relayerKeypair = Keypair.fromSecretKey(secretKey); // same funded devnet wallet acts as relayer/payer here
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(relayerKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(`${ROOT}/solana/target/idl/inaya_bridge_solana.json`, "utf8"));
  const program = new anchor.Program(idl, provider);

  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
  const bridgeConfig = pda([Buffer.from("bridge_config")]);
  const validatorSet = pda([Buffer.from("validator_set")]);
  const mint = pda([Buffer.from("bridged_inaya_mint")]);
  const mintAuthority = pda([Buffer.from("mint_authority")]);

  const chainIdLe = Buffer.alloc(8);
  chainIdLe.writeBigUInt64LE(BigInt(BSC_CHAIN_ID));
  const trustedChain = pda([Buffer.from("trusted_chain"), chainIdLe]);
  const nonceTracker = pda([Buffer.from("nonce_tracker"), chainIdLe]);

  const recipientTokenAccount = anchor.utils.token.associatedAddress({ mint, owner: solanaKeypair.publicKey });

  const messageArg = {
    sourceChainId: new BN(m.sourceChainId.toString()),
    sourceContract: Array.from(ethers.getBytes(m.sourceContract)),
    destChainId: new BN(m.destChainId.toString()),
    destContract: Array.from(ethers.getBytes(m.destContract)),
    nonce: new BN(m.nonce.toString()),
    msgType: Number(m.msgType),
    payload: Buffer.from(ethers.getBytes(m.payload)),
  };

  // instructionIndex must point at each secp instruction's OWN final position in the
  // transaction (0 and 1) -- the default (0) is only correct for the first one.
  const secpIx1 = Secp256k1Program.createInstructionWithEthAddress({ ethAddress: Buffer.from(sigs[0].ethAddress), message: Buffer.from(hashBytes), signature: Buffer.from(sigs[0].signature), recoveryId: sigs[0].recoveryId, instructionIndex: 0 });
  const secpIx2 = Secp256k1Program.createInstructionWithEthAddress({ ethAddress: Buffer.from(sigs[1].ethAddress), message: Buffer.from(hashBytes), signature: Buffer.from(sigs[1].signature), recoveryId: sigs[1].recoveryId, instructionIndex: 1 });

  const receiveIx = await program.methods
    .receiveMessage(messageArg, 2)
    .accounts({
      relayer: relayerKeypair.publicKey,
      bridgeConfig,
      validatorSet,
      trustedChain,
      nonceTracker,
      mint,
      mintAuthority,
      recipientTokenAccount,
      recipient: solanaKeypair.publicKey,
      instructionsSysvar: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  const txn = new Transaction().add(secpIx1, secpIx2, receiveIx);
  console.log("Submitting receive_message on Solana Devnet...");
  const sig = await sendAndConfirmTransaction(connection, txn, [relayerKeypair], { commitment: "confirmed" });
  console.log("receive_message tx:", sig);

  const tokenAccountInfo = await connection.getTokenAccountBalance(recipientTokenAccount);
  console.log("Recipient bridged-INAYA balance on Solana:", tokenAccountInfo.value.uiAmountString);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exitCode = 1;
});
