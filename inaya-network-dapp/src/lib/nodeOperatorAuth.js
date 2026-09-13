// src/lib/nodeOperatorAuth.js
//
// Node Operator Dashboard SOW — the first session/login layer node
// operators have ever had. Every existing node route (register, heartbeat,
// status) authenticates a single wallet-signed ACTION per request via
// nodeAuth.js's verifyNodeAuth(); nothing issues a session a browser
// dashboard could stay logged into. This mirrors orgs.js's createSession()/
// getSession() shape (hashed random token in a sessions-style collection,
// cookie holds the raw token) but wallet-keyed instead of email-keyed, and
// stored in the 'inaya_network' db (via the raw clientPromise) since that's
// where every other node collection already lives — never through
// getOrgCollections()'s connectToDatabase(), which points at the separate
// 'inaya_network_corporate' db.
//
// Login itself reuses verifyNodeAuth({action:'login', ...}) completely
// unchanged — no new signature-verification logic, just a session wrapped
// around a proof that already exists and is already daemon-compatible.

import { randomBytes, createHash } from "node:crypto";
import clientPromise from "./mongodb.js";
import { verifyNodeAuth } from "./nodeAuth.js";

export const NODE_SESSION_COOKIE = "inaya_node_session";
// An operator dashboard session gates financial/commission data — kept
// short-lived (12h) rather than orgs.js's 30-day org session.
export const NODE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const NODE_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: Math.floor(NODE_SESSION_TTL_MS / 1000),
};

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function generateToken() {
  return randomBytes(32).toString("hex");
}

export async function getNodeSessionCollections() {
  const client = await clientPromise;
  const db = client.db("inaya_network");
  return {
    db,
    nodes: db.collection("nodes"),
    nodeSessions: db.collection("node_sessions"),
  };
}

let indexesEnsured = false;
export async function ensureNodeSessionIndexes() {
  if (indexesEnsured) return;
  const { nodeSessions } = await getNodeSessionCollections();
  await Promise.all([
    nodeSessions.createIndex({ tokenHash: 1 }, { unique: true }),
    nodeSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  indexesEnsured = true;
}

/** Verifies a wallet-signed login proof — the exact same message/signature
 *  shape the CLI daemon already produces for register/heartbeat, just
 *  action:'login' — and requires the wallet to already be a registered
 *  node (logging into a node that was never registered makes no sense).
 *  Returns {error,status} or {sessionToken, walletAddress}. */
export async function loginWithWalletSignature({ walletAddress, message, signature, timestamp }) {
  if (!walletAddress) return { error: "walletAddress is required.", status: 400 };
  const wallet = walletAddress.toLowerCase();

  try {
    verifyNodeAuth({ action: "login", nodeId: wallet, operatorWallet: wallet, message, signature, timestamp });
  } catch (err) {
    return { error: err.message, status: 401 };
  }

  await ensureNodeSessionIndexes();
  const { nodes, nodeSessions } = await getNodeSessionCollections();
  const node = await nodes.findOne({ nodeId: wallet });
  if (!node) return { error: "This wallet isn't registered as a node yet.", status: 404 };

  const sessionToken = generateToken();
  const now = new Date();
  await nodeSessions.insertOne({
    tokenHash: hashToken(sessionToken),
    walletAddress: wallet,
    linkedWallets: [],
    createdAt: now,
    expiresAt: new Date(now.getTime() + NODE_SESSION_TTL_MS),
  });

  return { sessionToken, walletAddress: wallet };
}

export async function destroySession(rawToken) {
  if (!rawToken) return;
  const { nodeSessions } = await getNodeSessionCollections();
  await nodeSessions.deleteOne({ tokenHash: hashToken(rawToken) });
}

/** Every /api/nodes/operator/* route (except /network) calls this first.
 *  Returns {error,status} or {walletAddress, linkedWallets, sessionDoc} —
 *  callers scope every query to walletAddress/linkedWallets, never a
 *  client-supplied node ID. */
export async function requireNodeSession(req) {
  const rawToken = req.cookies.get(NODE_SESSION_COOKIE)?.value;
  if (!rawToken) return { error: "Not signed in.", status: 401 };

  const { nodeSessions } = await getNodeSessionCollections();
  const session = await nodeSessions.findOne({ tokenHash: hashToken(rawToken) });
  if (!session) return { error: "Session expired or invalid — please sign in again.", status: 401 };
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await nodeSessions.deleteOne({ _id: session._id });
    return { error: "Session expired — please sign in again.", status: 401 };
  }

  return { walletAddress: session.walletAddress, linkedWallets: session.linkedWallets || [], sessionDoc: session };
}

/** Links a second node wallet to the CURRENT session — requires THAT
 *  wallet's own signature (proving its owner authorized the link), not the
 *  primary session wallet's. The linked wallet must also already be a
 *  registered node. Idempotent: re-linking an already-linked wallet is a
 *  no-op, not an error. */
export async function linkWalletToSession(sessionDoc, { walletAddress, message, signature, timestamp }) {
  if (!walletAddress) return { error: "walletAddress is required.", status: 400 };
  const wallet = walletAddress.toLowerCase();
  if (wallet === sessionDoc.walletAddress) {
    return { error: "This wallet is already the primary node on this session.", status: 400 };
  }
  if ((sessionDoc.linkedWallets || []).includes(wallet)) {
    return { walletAddress: wallet, alreadyLinked: true };
  }

  try {
    verifyNodeAuth({ action: "login", nodeId: wallet, operatorWallet: wallet, message, signature, timestamp });
  } catch (err) {
    return { error: err.message, status: 401 };
  }

  const { nodes, nodeSessions } = await getNodeSessionCollections();
  const node = await nodes.findOne({ nodeId: wallet });
  if (!node) return { error: "This wallet isn't registered as a node yet.", status: 404 };

  await nodeSessions.updateOne({ _id: sessionDoc._id }, { $addToSet: { linkedWallets: wallet } });
  return { walletAddress: wallet, alreadyLinked: false };
}
