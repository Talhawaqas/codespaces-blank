// scripts/relayer-dry-run-sui.mjs
//
// Real end-to-end relayer dry run against the LIVE BSC Testnet <-> Sui Testnet deployment:
// bridgeOut on BSC, 2 validators sign the EIP-191 digest (same signMessage() every EVM spoke's
// relayer already uses), then submits receive_message on Sui via the sui CLI. Sui's native
// `ecdsa_k1::secp256k1_ecrecover` expects a 65-byte (r,s,v) signature with v in {0,1,2,3} --
// ethers' default `.serialized` uses legacy v=27/28, so this replaces the last byte with the
// plain recovery id (yParity) before submitting.
//
// Run with: node scripts/relayer-dry-run-sui.mjs

import { ethers } from "ethers";
import fs from "fs";
import { execFileSync } from "child_process";
import dotenv from "dotenv";

dotenv.config({ path: "inaya-network-dapp/.env.local" });
dotenv.config({ path: ".env" });

const SUI_BIN = "C:\\Users\\waqastal\\AppData\\Local\\Temp\\claude\\D--Codespace-blank-codespaces-blank-main-codespaces-blank-main-inaya-network-dapp-custody-sdk\\1a4dbb5a-ada6-44bd-a831-5ff6400924e3\\scratchpad\\sui-cli\\sui.exe";
const SUI_PACKAGE = "0xd47bd3b1bcb7bfb2674f372a603fa99acaf4d9dda122e649e8d7f6441aa27a66";
const SUI_BRIDGE_STATE = "0x1162bff1172c016f0fa794fe2fa811b413764aca9398cf607d44eb04f7ba100a";
const SUI_RECIPIENT = "0xcf13f96340bdd7b55e00b0f35b70721ffb7aa6ef00bd6fbd6f6da940cd4a5475"; // our own funded Sui wallet
const SUI_CHAIN_ID = 3_000_000_002n;
const THRESHOLD = 2;

const bsc = JSON.parse(fs.readFileSync("deployments/bridge/bscTestnet.json", "utf8"));

const BRIDGE_HOME_ABI = ["function bridgeOut(uint256 destChainId, bytes32 recipient, uint256 amount) external returns (bytes32)"];
const ERC20_ABI = ["function approve(address spender, uint256 amount) external returns (bool)"];
const MESSENGER_ABI = [
  "event MessageSent(bytes32 indexed messageId, tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message)",
];

async function main() {
  const homeProvider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC);
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, homeProvider);
  const validators = [1, 2, 3].map((i) => new ethers.Wallet(process.env[`BRIDGE_VALIDATOR_PRIVATE_KEY_${i}`]));

  console.log("Step 1: real bridgeOut on BSC Testnet (deployer:", deployer.address, ")");
  const inaya = new ethers.Contract(bsc.inayaToken, ERC20_ABI, deployer);
  const amount = ethers.parseUnits("1", 18); // 1 INAYA
  const TRANSFER_FEE = 100000000000000n;
  await (await inaya.approve(bsc.bridge, amount + TRANSFER_FEE)).wait();

  const bridgeHome = new ethers.Contract(bsc.bridge, BRIDGE_HOME_ABI, deployer);
  const tx = await bridgeHome.bridgeOut(SUI_CHAIN_ID, SUI_RECIPIENT, amount);
  const receipt = await tx.wait();
  console.log("  bridgeOut tx:", receipt.hash);

  const iface = new ethers.Interface(MESSENGER_ABI);
  const sentEvent = receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MessageSent");
  const messageId = sentEvent.args.messageId;
  const message = sentEvent.args.message;
  console.log("  messageId:", messageId);

  console.log("Step 2: 2 validators sign the EIP-191 digest of messageId, sui-style (r,s,yParity)");
  const signatures = [];
  for (const v of validators.slice(0, THRESHOLD)) {
    const sig = await v.signMessage(ethers.getBytes(messageId));
    const parsed = ethers.Signature.from(sig);
    const suiSig = ethers.hexlify(ethers.concat([parsed.r, parsed.s, Uint8Array.of(parsed.yParity)]));
    signatures.push(suiSig);
    console.log("  signed by", v.address, "yParity:", parsed.yParity, "sig:", suiSig);
  }

  console.log("Step 3: submit receive_message on Sui Testnet");
  const argsList = [
    SUI_BRIDGE_STATE,
    message.sourceChainId.toString(),
    message.sourceContract,
    message.destChainId.toString(),
    message.destContract,
    message.nonce.toString(),
    message.msgType.toString(),
    message.payload,
    `[${signatures.join(",")}]`,
  ];
  const out = execFileSync(SUI_BIN, [
    "client", "call",
    "--package", SUI_PACKAGE,
    "--module", "bridge",
    "--function", "receive_message",
    "--args", ...argsList,
    "--gas-budget", "100000000",
  ], { encoding: "utf8" });
  console.log(out);

  console.log("Step 4: verify recipient's wrapped INAYA balance on Sui");
  const balOut = execFileSync(SUI_BIN, ["client", "balance", SUI_RECIPIENT], { encoding: "utf8" });
  console.log(balOut);
}

main().catch((e) => { console.error(e); process.exit(1); });
