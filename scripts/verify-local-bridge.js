// scripts/verify-local-bridge.js -- one-off manual verification, run with plain `node`, not
// `hardhat run` (needs two independent provider connections at once).
//
//   node scripts/verify-local-bridge.js
//
// Proves a real cross-chain transfer end-to-end across two genuinely different chainIds
// (31337 home, 31338 spoke) running as separate Hardhat node processes -- the thing Phase 1's
// single-process Hardhat tests structurally could not exercise (executeMessage's
// destChainId == block.chainid check needs two REAL distinct chains to mean anything).
import { ethers } from "ethers";
import fs from "fs";

// Derived from Hardhat's well-known default test mnemonic, not hand-typed, to avoid transcription errors.
const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i) => ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`);
const DEPLOYER_PK = acct(0).privateKey;
const VALIDATOR_PKS = [acct(1).privateKey, acct(2).privateKey];

const home = JSON.parse(fs.readFileSync("deployments/bridge/localHome.json", "utf8"));
const spoke = JSON.parse(fs.readFileSync("deployments/bridge/localSepolia.json", "utf8"));

const artifact = (name) => JSON.parse(fs.readFileSync(`artifacts/contracts/bridge/${name}.sol/${name}.json`, "utf8"));
const tokenArtifact = JSON.parse(fs.readFileSync("artifacts/contracts/InayaToken.sol/InayaToken.json", "utf8"));

async function main() {
  const homeProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const spokeProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8546");
  const homeDeployer = new ethers.Wallet(DEPLOYER_PK, homeProvider);
  const spokeDeployer = new ethers.Wallet(DEPLOYER_PK, spokeProvider);

  const inaya = new ethers.Contract(home.inayaToken, tokenArtifact.abi, homeDeployer);
  const bridgeHome = new ethers.Contract(home.bridge, artifact("InayaTokenBridgeHome").abi, homeDeployer);
  const messengerHome = new ethers.Contract(home.messenger, artifact("InayaMessenger").abi, homeDeployer);
  const messengerSpoke = new ethers.Contract(spoke.messenger, artifact("InayaMessenger").abi, spokeDeployer);
  const wrapped = new ethers.Contract(spoke.wrappedToken, artifact("InayaWrappedINAYA").abi, spokeProvider);

  const recipientAddress = ethers.Wallet.createRandom().address;
  const recipientBytes32 = ethers.zeroPadValue(recipientAddress, 32);

  const amount = ethers.parseUnits("100", 18);
  const fee = 100000000000000n;

  // Explicit nonce sequencing: this Hardhat node's "pending" nonce count has been observed to
  // lag "latest" by one right after automining a block, which trips ethers' default nonce
  // lookup across repeated runs of this script against the same long-lived node.
  let nonce = await homeProvider.getTransactionCount(homeDeployer.address, "latest");

  console.log("Approving + bridging out 100 INAYA from home...");
  await (await inaya.approve(home.bridge, amount + fee, { nonce: nonce++ })).wait();
  const tx = await bridgeHome.bridgeOut(spoke.chainId, recipientBytes32, amount, { nonce: nonce++ });
  const receipt = await tx.wait();

  const iface = new ethers.Interface(artifact("InayaMessenger").abi);
  const event = receipt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "MessageSent");
  const messageId = event.args.messageId;
  const message = event.args.message;
  console.log("messageId:", messageId);

  const sigs = [];
  for (const pk of VALIDATOR_PKS) {
    const w = new ethers.Wallet(pk);
    sigs.push(await w.signMessage(ethers.getBytes(messageId)));
  }

  console.log("Delivering to spoke (chainId 31338) via a REAL separate node process...");
  const plainMessage = {
    sourceChainId: message.sourceChainId,
    sourceContract: message.sourceContract,
    destChainId: message.destChainId,
    destContract: message.destContract,
    nonce: message.nonce,
    msgType: message.msgType,
    payload: message.payload
  };
  const execTx = await messengerSpoke.executeMessage(plainMessage, sigs);
  await execTx.wait();

  const balance = await wrapped.balanceOf(recipientAddress);
  console.log(`Recipient wrapped INAYA balance on spoke: ${ethers.formatUnits(balance, 18)}`);
  if (balance !== amount) throw new Error("Balance mismatch -- something is wrong.");
  console.log("SUCCESS: real cross-process, cross-chainid bridge transfer verified.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
