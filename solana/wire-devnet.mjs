// solana/wire-devnet.mjs
//
// Real devnet on-chain wiring: initialize -> add_trusted_chain(BSC home) -> set_home_addresses.
// Run with: node wire-devnet.mjs (from inside WSL, where the Solana toolchain + id.json live)

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import os from "os";
import path from "path";

const PROGRAM_ID = new PublicKey("76KGt54jrh142nibdFH9BtZHxSu68rrDwxCTp5d98kZn");
const SOLANA_DEVNET_CHAIN_ID = new BN(1_000_000_002);
const BSC_TESTNET_CHAIN_ID = new BN(97);
const THRESHOLD = 2;

const VALIDATOR_ADDRESSES = [
  "2Bc397838e81D3b041690361402A4f991A5f34c3",
  "489884b7B58AA48e4E5729d23b9b9730c69674Fe",
  "3d7D4A2facC9c786AC1FE928FB34C3d0150289a8",
].map((hex) => Array.from(Buffer.from(hex, "hex")));

const ROOT = process.platform === "win32"
  ? "D:/Codespace-blank/codespaces-blank-main/codespaces-blank-main"
  : "/mnt/d/Codespace-blank/codespaces-blank-main/codespaces-blank-main";
const bsc = JSON.parse(fs.readFileSync(`${ROOT}/deployments/bridge/bscTestnet.json`, "utf8"));

function addressToBytes32(hexAddr) {
  const clean = hexAddr.replace(/^0x/, "").toLowerCase().padStart(40, "0");
  const buf = Buffer.alloc(32);
  Buffer.from(clean, "hex").copy(buf, 12);
  return Array.from(buf);
}

async function tryStep(name, fn) {
  try {
    const tx = await fn();
    console.log(`${name}: OK, tx=${tx}`);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("already in use") || msg.includes("custom program error: 0x0") || msg.includes("already initialized")) {
      console.log(`${name}: already done, skipping (${msg.slice(0, 80)})`);
    } else {
      console.log(`${name}: FAILED -- ${msg.slice(0, 300)}`);
    }
  }
}

async function main() {
  const idl = JSON.parse(fs.readFileSync(`${ROOT}/solana/target/idl/inaya_bridge_solana.json`, "utf8"));
  const walletPath = process.platform === "win32" ? `${ROOT}/solana/devnet-id.json` : path.join(os.homedir(), ".config/solana/id.json");
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8")));
  const keypair = Keypair.fromSecretKey(secretKey);

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed", skipPreflight: false });
  anchor.setProvider(provider);

  const program = new anchor.Program(idl, provider);

  const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
  const bridgeConfig = pda([Buffer.from("bridge_config")]);
  const validatorSet = pda([Buffer.from("validator_set")]);
  const mint = pda([Buffer.from("bridged_inaya_mint")]);
  const mintAuthority = pda([Buffer.from("mint_authority")]);
  const outboundNonce = pda([Buffer.from("outbound_nonce")]);

  console.log("admin/wallet:", keypair.publicKey.toBase58());
  console.log("bridgeConfig:", bridgeConfig.toBase58());

  await tryStep("initialize", () =>
    program.methods
      .initialize(keypair.publicKey, SOLANA_DEVNET_CHAIN_ID, BSC_TESTNET_CHAIN_ID, THRESHOLD, VALIDATOR_ADDRESSES)
      .accounts({
        payer: keypair.publicKey,
        bridgeConfig,
        validatorSet,
        mint,
        mintAuthority,
        outboundNonceCounter: outboundNonce,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc()
  );

  const chainIdLe = Buffer.alloc(8);
  chainIdLe.writeBigUInt64LE(97n);
  const trustedChain = pda([Buffer.from("trusted_chain"), chainIdLe]);
  const nonceTracker = pda([Buffer.from("nonce_tracker"), chainIdLe]);

  await tryStep("add_trusted_chain", () =>
    program.methods
      .addTrustedChain(BSC_TESTNET_CHAIN_ID, true)
      .accounts({
        admin: keypair.publicKey,
        bridgeConfig,
        trustedChain,
        nonceTracker,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc()
  );

  const homeBridgeAddress = addressToBytes32(bsc.bridge);
  const homeStakingGatewayAddress = addressToBytes32(bsc.stakingGateway);

  await tryStep("set_home_addresses", () =>
    program.methods
      .setHomeAddresses(homeBridgeAddress, homeStakingGatewayAddress)
      .accounts({ admin: keypair.publicKey, bridgeConfig })
      .rpc()
  );

  try {
    const config = await program.account.bridgeConfig.fetch(bridgeConfig);
    console.log("Final bridgeConfig:", {
      admin: config.admin.toBase58(),
      selfChainId: config.selfChainId.toString(),
      homeChainId: config.homeChainId.toString(),
      paused: config.paused,
    });
  } catch (e) {
    console.log("Could not fetch final state (read-path flakiness):", String(e.message).slice(0, 150));
  }
  console.log("DONE");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
