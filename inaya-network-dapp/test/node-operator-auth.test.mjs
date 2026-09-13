// test/node-operator-auth.test.mjs
//
// Node Operator Dashboard SOW — session/auth layer. This is the highest-
// risk new surface in the SOW (gates real financial/commission data), so
// it gets full coverage rather than the lighter per-feature convention
// used elsewhere: real wallet signatures via ethers.Wallet (not stubs),
// against the exact message format nodeAuth.js's verifyNodeAuth already
// expects and the CLI daemon already produces.
//
// Run with: node --env-file=.env.local --test test/node-operator-auth.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  loginWithWalletSignature,
  requireNodeSession,
  linkWalletToSession,
  destroySession,
  getNodeSessionCollections,
  NODE_SESSION_COOKIE,
} from "../src/lib/nodeOperatorAuth.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const cleanup = { wallets: [] };

function buildLoginMessage(nodeId, timestamp) {
  return ["Inaya Node Action", "action: login", `nodeId: ${nodeId}`, `timestamp: ${timestamp}`].join("\n");
}

async function signLogin(wallet) {
  const timestamp = Date.now();
  const nodeId = wallet.address.toLowerCase();
  const message = buildLoginMessage(nodeId, timestamp);
  const signature = await wallet.signMessage(message);
  return { walletAddress: wallet.address, message, signature, timestamp };
}

async function registerFixtureNode(wallet) {
  const { nodes } = await getNodeSessionCollections();
  const nodeId = wallet.address.toLowerCase();
  cleanup.wallets.push(nodeId);
  await nodes.insertOne({
    nodeId, operatorWallet: nodeId, totalCapacityGB: 100, usedCapacityGB: 0, shardsStored: 0,
    uptimeScoreBps: 8000, tier: "Entry", acceptingNewShards: true, registeredAt: new Date(), lastHeartbeatAt: new Date(),
  });
}

function fakeReq(rawToken) {
  return { cookies: { get: (name) => (name === NODE_SESSION_COOKIE && rawToken ? { value: rawToken } : undefined) } };
}

after(async () => {
  const { nodes, nodeSessions } = await getNodeSessionCollections();
  await nodes.deleteMany({ nodeId: { $in: cleanup.wallets } });
  await nodeSessions.deleteMany({ walletAddress: { $in: cleanup.wallets } });
  const client = await mongoClientPromise;
  await client.close();
});

test("login succeeds for a real signature from a registered node's own wallet", async () => {
  const wallet = ethers.Wallet.createRandom();
  await registerFixtureNode(wallet);
  const proof = await signLogin(wallet);

  const result = await loginWithWalletSignature(proof);
  assert.ok(result.sessionToken, "expected a session token on success");
  assert.equal(result.walletAddress, wallet.address.toLowerCase());

  const session = await requireNodeSession(fakeReq(result.sessionToken));
  assert.equal(session.walletAddress, wallet.address.toLowerCase());

  await destroySession(result.sessionToken);
});

test("VALIDATION: login is rejected for a wallet that has never registered a node", async () => {
  const wallet = ethers.Wallet.createRandom(); // deliberately not registered
  const proof = await signLogin(wallet);
  const result = await loginWithWalletSignature(proof);
  assert.equal(result.status, 404);
});

test("SECURITY: a signature from wallet B cannot authenticate as wallet A", async () => {
  const walletA = ethers.Wallet.createRandom();
  const walletB = ethers.Wallet.createRandom();
  await registerFixtureNode(walletA);

  // walletB signs a message that CLAIMS to be walletA's nodeId/operatorWallet.
  const timestamp = Date.now();
  const nodeId = walletA.address.toLowerCase();
  const message = buildLoginMessage(nodeId, timestamp);
  const forgedSignature = await walletB.signMessage(message);

  const result = await loginWithWalletSignature({ walletAddress: walletA.address, message, signature: forgedSignature, timestamp });
  assert.equal(result.status, 401, "a signature that doesn't recover to the claimed wallet must be rejected");
});

test("SECURITY: an expired signature is rejected", async () => {
  const wallet = ethers.Wallet.createRandom();
  await registerFixtureNode(wallet);
  const timestamp = Date.now() - 10 * 60 * 1000; // 10 minutes old, past the 5-minute window
  const nodeId = wallet.address.toLowerCase();
  const message = buildLoginMessage(nodeId, timestamp);
  const signature = await wallet.signMessage(message);

  const result = await loginWithWalletSignature({ walletAddress: wallet.address, message, signature, timestamp });
  assert.equal(result.status, 401);
  assert.match(result.error, /expired/i);
});

test("SECURITY: a tampered message field (mismatched nodeId) is rejected", async () => {
  const walletA = ethers.Wallet.createRandom();
  const walletB = ethers.Wallet.createRandom();
  await registerFixtureNode(walletA);

  // walletA signs a message for its OWN nodeId, but the request claims a
  // different walletAddress (walletB) -- the signature won't recover to
  // walletB, so this must fail exactly like the forged-signature case.
  const timestamp = Date.now();
  const message = buildLoginMessage(walletA.address.toLowerCase(), timestamp);
  const signature = await walletA.signMessage(message);

  const result = await loginWithWalletSignature({ walletAddress: walletB.address, message, signature, timestamp });
  assert.equal(result.status, 401);
});

test("SECURITY: two concurrent sessions never cross-resolve to the wrong wallet", async () => {
  const walletA = ethers.Wallet.createRandom();
  const walletB = ethers.Wallet.createRandom();
  await registerFixtureNode(walletA);
  await registerFixtureNode(walletB);

  const resultA = await loginWithWalletSignature(await signLogin(walletA));
  const resultB = await loginWithWalletSignature(await signLogin(walletB));

  const sessionA = await requireNodeSession(fakeReq(resultA.sessionToken));
  const sessionB = await requireNodeSession(fakeReq(resultB.sessionToken));

  assert.equal(sessionA.walletAddress, walletA.address.toLowerCase());
  assert.equal(sessionB.walletAddress, walletB.address.toLowerCase());
  assert.notEqual(sessionA.walletAddress, sessionB.walletAddress);

  await destroySession(resultA.sessionToken);
  await destroySession(resultB.sessionToken);
});

test("VALIDATION: no cookie means no session", async () => {
  const result = await requireNodeSession(fakeReq(null));
  assert.equal(result.status, 401);
});

test("VALIDATION: a garbage token resolves to no session", async () => {
  const result = await requireNodeSession(fakeReq("not-a-real-token"));
  assert.equal(result.status, 401);
});

test("SECURITY: linking a second wallet requires THAT wallet's own signature, not the primary session wallet's", async () => {
  const primary = ethers.Wallet.createRandom();
  const toLink = ethers.Wallet.createRandom();
  await registerFixtureNode(primary);
  await registerFixtureNode(toLink);

  const loginResult = await loginWithWalletSignature(await signLogin(primary));
  const session = await requireNodeSession(fakeReq(loginResult.sessionToken));

  // primary wallet signs a message CLAIMING to be the wallet being linked --
  // must fail, since the signature recovers to `primary`, not `toLink`.
  const timestamp = Date.now();
  const forgedMessage = buildLoginMessage(toLink.address.toLowerCase(), timestamp);
  const forgedSignature = await primary.signMessage(forgedMessage);
  const forged = await linkWalletToSession(session.sessionDoc, {
    walletAddress: toLink.address, message: forgedMessage, signature: forgedSignature, timestamp,
  });
  assert.equal(forged.status, 401, "linking must require the linked wallet's own signature");

  // The linked wallet's own real signature succeeds.
  const real = await linkWalletToSession(session.sessionDoc, await signLogin(toLink));
  assert.equal(real.alreadyLinked, false);
  assert.equal(real.walletAddress, toLink.address.toLowerCase());

  await destroySession(loginResult.sessionToken);
});
