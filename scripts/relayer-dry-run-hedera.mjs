// scripts/relayer-dry-run-hedera.mjs
//
// Real end-to-end relayer dry run against the LIVE BSC Testnet <-> Hedera Testnet deployment,
// same shape as scripts/relayer-dry-run.mjs (BSC <-> Sepolia).
//
// Run with: node scripts/relayer-dry-run-hedera.mjs

import { ethers } from "ethers";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({ path: "inaya-network-dapp/.env.local" });
dotenv.config({ path: ".env" });

const bsc = JSON.parse(fs.readFileSync("deployments/bridge/bscTestnet.json", "utf8"));
const hedera = JSON.parse(fs.readFileSync("deployments/bridge/hederaTestnet.json", "utf8"));

const BRIDGE_HOME_ABI = ["function bridgeOut(uint256 destChainId, bytes32 recipient, uint256 amount) external returns (bytes32)"];
const ERC20_ABI = ["function approve(address spender, uint256 amount) external returns (bool)"];
const MESSENGER_ABI = [
  "event MessageSent(bytes32 indexed messageId, tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message)",
  "function executeMessage(tuple(uint256 sourceChainId, bytes32 sourceContract, uint256 destChainId, bytes32 destContract, uint256 nonce, uint8 msgType, bytes payload) message, bytes[] signatures) external",
];
const WRAPPED_ABI = ["function balanceOf(address account) view returns (uint256)"];

const TRANSFER_FEE = 100000000000000n;
const THRESHOLD = 2;

async function main() {
  const homeProvider = new ethers.JsonRpcProvider(process.env.BSC_TESTNET_RPC);
  const spokeProvider = new ethers.JsonRpcProvider(process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api");

  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, homeProvider);
  const relayer = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, spokeProvider);
  const validators = [1, 2, 3].map((i) => new ethers.Wallet(process.env[`BRIDGE_VALIDATOR_PRIVATE_KEY_${i}`]));

  console.log("Step 1: real bridgeOut on BSC Testnet (deployer:", deployer.address, ")");
  const inaya = new ethers.Contract(bsc.inayaToken, ERC20_ABI, deployer);
  const amount = ethers.parseUnits("1", 18); // 1 INAYA, real testnet transfer
  await (await inaya.approve(bsc.bridge, amount + TRANSFER_FEE)).wait();

  const bridgeHome = new ethers.Contract(bsc.bridge, BRIDGE_HOME_ABI, deployer);
  const recipient = deployer.address; // send back to ourselves on Hedera for easy verification
  const tx = await bridgeHome.bridgeOut(hedera.chainId, ethers.zeroPadValue(recipient, 32), amount);
  const receipt = await tx.wait();
  console.log("  bridgeOut tx:", receipt.hash);

  const iface = new ethers.Interface(MESSENGER_ABI);
  const sentEvent = receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MessageSent");
  const messageId = sentEvent.args.messageId;
  const message = sentEvent.args.message;
  console.log("  messageId:", messageId);

  console.log("Step 2: each validator signs the message hash (same as cron/relay-messages)");
  const signatures = [];
  for (const v of validators.slice(0, THRESHOLD)) {
    const sig = await v.signMessage(ethers.getBytes(messageId));
    signatures.push(sig);
    console.log("  signed by", v.address);
  }

  console.log("Step 3: relayer submits executeMessage on Hedera Testnet (relayer:", relayer.address, ")");
  const messengerSpoke = new ethers.Contract(hedera.messenger, MESSENGER_ABI, relayer);
  const plainMessage = {
    sourceChainId: message.sourceChainId,
    sourceContract: message.sourceContract,
    destChainId: message.destChainId,
    destContract: message.destContract,
    nonce: message.nonce,
    msgType: message.msgType,
    payload: message.payload,
  };
  const execTx = await messengerSpoke.executeMessage(plainMessage, signatures);
  const execReceipt = await execTx.wait();
  console.log("  executeMessage tx:", execReceipt.hash);

  const wrapped = new ethers.Contract(hedera.wrappedToken, WRAPPED_ABI, spokeProvider);
  const balance = await wrapped.balanceOf(recipient);
  console.log("Recipient wrapped INAYA balance on Hedera:", ethers.formatUnits(balance, 18));
  console.log(balance >= amount ? "SUCCESS: real relayer dry run confirmed end-to-end on live testnets." : "MISMATCH");
}

main().catch((e) => { console.error(e); process.exit(1); });
