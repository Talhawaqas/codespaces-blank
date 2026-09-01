// scripts/relayer-dry-run-aptos.mjs
//
// Real end-to-end relayer dry run against the LIVE BSC Testnet <-> Aptos Testnet deployment:
// bridgeOut on BSC, 2 validators sign the EIP-191 digest (same signMessage() every EVM spoke's
// relayer already uses -- Aptos's native secp256k1::ecdsa_recover needs no special-casing, see
// aptos/.../message.move's doc), then submits receive_message on Aptos via the aptos CLI (its
// vector<vector<u8>> arg support makes a JSON-args-file round trip through the CLI the simplest
// path -- no need for the full @aptos-labs/ts-sdk here).
//
// Run with: node scripts/relayer-dry-run-aptos.mjs

import { ethers } from "ethers";
import fs from "fs";
import { execFileSync } from "child_process";
import dotenv from "dotenv";

dotenv.config({ path: "inaya-network-dapp/.env.local" });
dotenv.config({ path: ".env" });

const APTOS_URL = "https://fullnode.testnet.aptoslabs.com/v1";
const APTOS_DEPLOYER = "0xc4bf038a4ed931ea21acf4a1da08ddd308a490b7fcd4c96d7592e6eba053efee";
const APTOS_PRIVATE_KEY = "a04631351e6825ea5b914a967cd56ff6a3d9e6623e21e260b395cf0481b53845";
const APTOS_CHAIN_ID = 2_000_000_002n;
const THRESHOLD = 2;
const SCRATCH = "C:\\Users\\waqastal\\AppData\\Local\\Temp\\claude\\D--Codespace-blank-codespaces-blank-main-codespaces-blank-main-inaya-network-dapp-custody-sdk\\1a4dbb5a-ada6-44bd-a831-5ff6400924e3\\scratchpad";

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

  // recipient: our own Aptos deployer account (32-byte native address) so we can verify balance easily
  const recipientBytes32 = APTOS_DEPLOYER;

  const bridgeHome = new ethers.Contract(bsc.bridge, BRIDGE_HOME_ABI, deployer);
  const tx = await bridgeHome.bridgeOut(APTOS_CHAIN_ID, recipientBytes32, amount);
  const receipt = await tx.wait();
  console.log("  bridgeOut tx:", receipt.hash);

  const iface = new ethers.Interface(MESSENGER_ABI);
  const sentEvent = receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MessageSent");
  const messageId = sentEvent.args.messageId;
  const message = sentEvent.args.message;
  console.log("  messageId:", messageId);

  console.log("Step 2: 2 validators sign the EIP-191 digest of messageId (same as every EVM spoke)");
  const signatures = [];
  const recoveryIds = [];
  for (const v of validators.slice(0, THRESHOLD)) {
    const sig = await v.signMessage(ethers.getBytes(messageId));
    const parsed = ethers.Signature.from(sig);
    signatures.push(ethers.hexlify(ethers.concat([parsed.r, parsed.s])));
    recoveryIds.push(parsed.yParity);
    console.log("  signed by", v.address, "recoveryId:", parsed.yParity);
  }

  console.log("Step 3: submit receive_message on Aptos Testnet");
  const argsFile = `${SCRATCH}\\aptos_receive_message_args.json`;
  const args = {
    function_id: `${APTOS_DEPLOYER}::bridge::receive_message`,
    type_args: [],
    args: [
      { type: "address", value: APTOS_DEPLOYER }, // bridge_admin
      { type: "u64", value: message.sourceChainId.toString() },
      { type: "hex", value: message.sourceContract },
      { type: "u64", value: message.destChainId.toString() },
      { type: "hex", value: message.destContract },
      { type: "u64", value: message.nonce.toString() },
      { type: "u8", value: message.msgType.toString() },
      { type: "hex", value: message.payload },
      { type: "hex", value: signatures },
      { type: "u8", value: recoveryIds },
    ],
  };
  fs.writeFileSync(argsFile, JSON.stringify(args, null, 2));

  const keyFile = `${SCRATCH}\\aptos_deployer.key`;
  const NPX_CWD = "D:/Codespace-blank/codespaces-blank-main/codespaces-blank-main/inaya-network-dapp/custody-sdk";
  const out = execFileSync("npx", [
    "aptos", "move", "run",
    "--json-file", argsFile,
    "--private-key-file", keyFile,
    "--url", APTOS_URL,
    "--assume-yes",
  ], { encoding: "utf8", shell: true, cwd: NPX_CWD });
  console.log(out);

  console.log("Step 4: verify recipient's wrapped INAYA balance on Aptos");
  const balanceOut = execFileSync("npx", [
    "aptos", "move", "view",
    "--function-id", `${APTOS_DEPLOYER}::bridge::wrapped_balance`,
    "--args", `address:${APTOS_DEPLOYER}`, `address:${APTOS_DEPLOYER}`,
    "--url", APTOS_URL,
  ], { encoding: "utf8", shell: true, cwd: NPX_CWD });
  console.log(balanceOut);
}

main().catch((e) => { console.error(e); process.exit(1); });
