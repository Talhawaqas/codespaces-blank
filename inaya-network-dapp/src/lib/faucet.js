// src/lib/faucet.js
//
// Tracking for the testnet token faucet (api/faucet/route.js) — every
// request gets a real MongoDB record: wallet address, requester IP,
// what was actually sent (or why it was skipped), and when. The faucet
// route previously did zero tracking at all — no way to see who'd
// requested tokens, how often, or spot obvious multi-wallet farming.
// This only adds visibility (an admin dashboard); it doesn't block or
// rate-limit anything on its own — see the fraud/abuse risk layer
// (lib/fraudRisk.js) if that's needed later, kept separate on purpose.
//
// Same shape as every other src/lib/X.js in this codebase:
// getXCollections, ensureXIndexes, recordX, listRecentX.

import { connectToDatabase } from "./mongodb.js";

export async function getFaucetCollections() {
  const { db } = await connectToDatabase();
  return { db, requests: db.collection("faucet_requests") };
}

let indexesEnsured = false;

export async function ensureFaucetIndexes() {
  if (indexesEnsured) return;
  const { requests } = await getFaucetCollections();
  await Promise.all([
    requests.createIndex({ walletAddress: 1, createdAt: -1 }),
    requests.createIndex({ createdAt: -1 }),
    requests.createIndex({ ipAddress: 1, createdAt: -1 }),
  ]);
  indexesEnsured = true;
}

/** Records one faucet request outcome. Never throws — a tracking failure
 *  should never be the reason a real token drip fails to return a
 *  response, matching this codebase's established fail-open convention
 *  for anything that's observability rather than the actual feature. */
export async function recordFaucetRequest({ walletAddress, ipAddress, results }) {
  try {
    await ensureFaucetIndexes();
    const { requests } = await getFaucetCollections();
    await requests.insertOne({
      walletAddress: walletAddress.toLowerCase(),
      ipAddress: ipAddress || "unknown",
      inayaSent: !!results?.inaya?.sent,
      inayaAmount: results?.inaya?.sent ? results.inaya.amount : null,
      inayaTxHash: results?.inaya?.sent ? results.inaya.txHash : null,
      usdtSent: !!results?.usdt?.sent,
      usdtAmount: results?.usdt?.sent ? results.usdt.amount : null,
      usdtTxHash: results?.usdt?.sent ? results.usdt.txHash : null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("recordFaucetRequest failed (non-fatal, faucet dispatch already completed):", err.message);
  }
}

export async function listRecentFaucetRequests(limit = 200) {
  const { requests } = await getFaucetCollections();
  const docs = await requests.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
  return docs.map((d) => ({ ...d, id: d._id.toString(), _id: undefined }));
}

/** Wallet-level history — every request a specific address has made,
 *  most recent first. Used by the admin dashboard's per-wallet lookup. */
export async function listFaucetRequestsForWallet(walletAddress) {
  const { requests } = await getFaucetCollections();
  const docs = await requests
    .find({ walletAddress: walletAddress.toLowerCase() })
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map((d) => ({ ...d, id: d._id.toString(), _id: undefined }));
}

export async function getFaucetStats() {
  const { requests } = await getFaucetCollections();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [total, last24h, uniqueWallets] = await Promise.all([
    requests.countDocuments({}),
    requests.countDocuments({ createdAt: { $gte: since24h } }),
    requests.distinct("walletAddress"),
  ]);

  return { total, last24h, uniqueWallets: uniqueWallets.length };
}

// ============================================================
// Faucet caps: 500 $INAYA lifetime per wallet, 1000 unique wallets total.
// Both enforced here (tracked-history-based), not via on-chain balance
// checks -- a balance check can't tell "already received the full
// allowance and spent it" apart from "never requested," which a lifetime
// tracked total can. mUSDT is untouched -- these caps are INAYA-specific.
// ============================================================
export const FAUCET_INAYA_LIFETIME_CAP = 500;
export const FAUCET_MAX_UNIQUE_WALLETS = 1000;

/** Sums every past inayaAmount actually sent to this wallet via the
 *  faucet. Skipped/failed requests contribute 0 (inayaAmount is null on
 *  those). Used to enforce the lifetime cap regardless of what the
 *  wallet's current on-chain balance happens to be (spent, transferred
 *  out, whatever) -- the cap is about what the faucet has ever given it. */
export async function getTotalInayaSentToWallet(walletAddress) {
  const { requests } = await getFaucetCollections();
  const docs = await requests
    .find({ walletAddress: walletAddress.toLowerCase(), inayaSent: true })
    .project({ inayaAmount: 1 })
    .toArray();
  return docs.reduce((sum, d) => sum + (parseFloat(d.inayaAmount) || 0), 0);
}

/** True if this wallet has never successfully received anything from the
 *  faucet before -- used to decide whether the 1000-unique-wallet cap
 *  applies to this request (existing wallets can still top up to their
 *  own 500 cap even once the faucet is "full" to new participants). */
export async function isNewFaucetWallet(walletAddress) {
  const { requests } = await getFaucetCollections();
  const count = await requests.countDocuments({ walletAddress: walletAddress.toLowerCase(), inayaSent: true }, { limit: 1 });
  return count === 0;
}

export async function getUniqueWalletCount() {
  const { requests } = await getFaucetCollections();
  const wallets = await requests.distinct("walletAddress", { inayaSent: true });
  return wallets.length;
}
