import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { replicateShard } from '@/lib/backupEngine';
import { getRawSessionToken, getSession } from '@/lib/orgs';
import { randomBytes } from 'node:crypto';
import { getProvider, listAvailableProviders } from '@/lib/pinningProviders/index.js';
import { realStorageAllowed } from '@/lib/pinningProviders/testGuard.js';

// Backup & Recovery Mechanism (docs/backup-redundancy-architecture.md) — best-effort fan-out to a
// second pinning provider after THIS route's own primary Pinata pin succeeds, bounded by a soft
// timeout so a slow/unreachable secondary provider adds at most REPLICATE_SOFT_TIMEOUT_MS to the
// upload response, never longer. Deliberately AWAITED (not left truly detached after the
// response is sent) -- Vercel serverless functions don't guarantee unawaited work continues
// running once a response has gone out, so "best-effort" here means "bounded-latency, not
// blocking indefinitely," not "run after we've already responded." Any failure or timeout is
// swallowed (never fails the upload itself) -- the check-pins cron is the real safety net for
// anything that doesn't complete here (see backupEngine.js's own module comment).
const REPLICATE_SOFT_TIMEOUT_MS = 8000;

// walletAddress used to be optional -- the per-wallet subscription/rate-limit check below only
// ran when it was present, so simply omitting it from the request body bypassed every limit and
// turned this route into an unauthenticated, unmetered proxy to Inaya's own billed Pinata
// account. A caller now needs EITHER a real walletAddress OR an active Business Workspace
// session (see the POST handler) -- something this app can actually hold accountable for usage.
// MAX_ENCODED_SHARD_LENGTH bounds the other half of that gap -- an unbounded payload size, even
// from an identified caller, is still a cost/DoS vector against Pinata. ~6MB raw per shard
// (base64 adds ~33%) comfortably covers this app's client-side sharding while staying well under
// what a single pin request should reasonably need.
const MAX_ENCODED_SHARD_LENGTH = 8 * 1024 * 1024;

// Pins one shard: Pinata first (the established primary), then every other configured provider (Filebase in
// production; the local store during test runs, see pinningProviders/testGuard.js). SQA 17 Nov 2026: Pinata's
// plan filled up and, with no fallback, every Workspace upload failed; its error text (which can echo
// credentials) was also passed straight back to the browser. Now a refusal falls through to the next provider,
// and provider responses are only ever logged by status.
async function pinShardWithFallback(content, name) {
  const jwt = (process.env.PINATA_JWT || "").trim();
  if (jwt && realStorageAllowed()) {
    try {
      const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ pinataContent: content, pinataMetadata: { name } }),
      });
      if (response.ok) {
        const data = await response.json();
        return { provider: "pinata", cid: data.IpfsHash, providerRef: data.IpfsHash };
      }
      console.error("upload: Pinata refused the pin, status", response.status, "- trying the next provider");
    } catch (err) {
      console.error("upload: Pinata unreachable -", err?.name || "error", "- trying the next provider");
    }
  }
  // Same JSON body Pinata stores, so every reader's `.shard` lookup works unchanged. Unique object names: two
  // uploads of files with the same name must never overwrite each other at an S3-style provider.
  const unique = `${name}_${Date.now()}_${randomBytes(4).toString("hex")}`;
  for (const providerName of listAvailableProviders().filter((p) => p !== "pinata")) {
    try {
      const r = await getProvider(providerName).pin(JSON.stringify(content), { name: unique });
      return { provider: r.provider, cid: r.cid, providerRef: r.providerRef };
    } catch (err) {
      console.error(`upload: provider ${providerName} refused the pin -`, String(err?.message || "").slice(0, 80));
    }
  }
  return null;
}

async function replicateShardBestEffort({ fileHash, shardId, content, primaryProvider, primaryCid, primaryProviderRef = primaryCid }) {
  if (!fileHash || !shardId) return; // caller (below) only has a real fileHash/shardId once the client sends them — see the request body change
  const timeout = new Promise((resolve) => setTimeout(resolve, REPLICATE_SOFT_TIMEOUT_MS));
  try {
    await Promise.race([replicateShard({ fileHash, shardId, content, primaryProvider, primaryCid, primaryProviderRef }), timeout]);
  } catch (err) {
    console.error('backup replicateShard (best-effort) failed:', err.message);
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { encryptedShard, filename, elementTag, walletAddress, selectedTier, fileHash, shardId } = body;

    // Two legitimate, unrelated callers share this one route: the wallet-connected PAYG/B2B
    // upload flow (page.js, sends walletAddress, metered below by the subscription check) and
    // the session-authenticated Business Workspace flow (clientCrypto.js, no wallet at all --
    // org membership is the identity there). Either is an acceptable caller; NEITHER is what let
    // this route be hit anonymously before -- a request with no session AND no walletAddress has
    // nothing this app can hold accountable for usage, so it's rejected outright.
    const hasWalletAddress = typeof walletAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    const session = hasWalletAddress ? null : await getSession(getRawSessionToken(request));
    if (!hasWalletAddress && !session) {
      return NextResponse.json({ error: "A valid walletAddress or an active session is required." }, { status: 401 });
    }
    if (typeof encryptedShard !== 'string' || encryptedShard.length === 0 || encryptedShard.length > MAX_ENCODED_SHARD_LENGTH) {
      return NextResponse.json({ error: "encryptedShard is missing or exceeds the size limit." }, { status: 413 });
    }


    // 🔒 MONGO-BACKED B2B SUBSCRIPTION CHECK SYSTEM -- only applies to the wallet-identified
    // path; a session-authenticated Business Workspace caller has no wallet to key this on.
    if (hasWalletAddress) {
      const { db } = await connectToDatabase();
      const subscriptionsCollection = db.collection("user_subscriptions");
      const cleanWallet = walletAddress.toLowerCase();

      // Find or initialize account document parameters
      let userSubscription = await subscriptionsCollection.findOne({ walletAddress: cleanWallet });

      if (!userSubscription) {
        let maxApiLimit = 15000000; // Scale Matrix Base (15M)
        if (selectedTier === 'Established Swarm') maxApiLimit = 150000000; // 150M
        if (selectedTier === 'Institutional Node') maxApiLimit = 9999999999; // Unlimited Allocations

        userSubscription = {
          walletAddress: cleanWallet,
          tier: selectedTier || 'Scale Matrix',
          apiRequestsCount: 0,
          maxApiLimit: maxApiLimit,
          lastReset: new Date()
        };
        await subscriptionsCollection.insertOne(userSubscription);
      }

      // Enforce business SLA threshold validation loops
      if (userSubscription.apiRequestsCount >= userSubscription.maxApiLimit) {
        return NextResponse.json({
          error: `🚨 SLA Threshold Violation: Monthly API limit of ${userSubscription.maxApiLimit.toLocaleString()} requests hit for ${userSubscription.tier}.`
        }, { status: 429 });
      }

      // Atomic allocation counter scaling
      await subscriptionsCollection.updateOne(
        { walletAddress: cleanWallet },
        {
          $inc: { apiRequestsCount: 1 },
          $set: { tier: selectedTier || userSubscription.tier }
        }
      );
    }

    const pinned = await pinShardWithFallback({ shard: encryptedShard, element: elementTag }, `inaya_next_${elementTag}_${filename}`);
    if (!pinned) {
      return NextResponse.json({ error: "Storage is temporarily unavailable. Please try again in a few minutes." }, { status: 503 });
    }

    await replicateShardBestEffort({ fileHash, shardId, content: encryptedShard, primaryProvider: pinned.provider, primaryCid: pinned.cid, primaryProviderRef: pinned.providerRef });

    return NextResponse.json({ IpfsHash: pinned.cid });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}