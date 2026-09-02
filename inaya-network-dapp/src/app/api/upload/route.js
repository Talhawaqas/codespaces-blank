import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { replicateShard } from '@/lib/backupEngine';
import { getRawSessionToken, getSession } from '@/lib/orgs';

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

async function replicateShardBestEffort({ fileHash, shardId, content, primaryProvider, primaryCid }) {
  if (!fileHash || !shardId) return; // caller (below) only has a real fileHash/shardId once the client sends them — see the request body change
  const timeout = new Promise((resolve) => setTimeout(resolve, REPLICATE_SOFT_TIMEOUT_MS));
  try {
    await Promise.race([replicateShard({ fileHash, shardId, content, primaryProvider, primaryCid }), timeout]);
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

    // 🔑 Updated to use Pinata JWT (Modern Method)
    const pinataJWT = process.env.PINATA_JWT;

    if (!pinataJWT) {
      return NextResponse.json({ error: "System Error: Server missing PINATA_JWT environment token." }, { status: 500 });
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

    const url = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
    const payload = {
      pinataContent: { shard: encryptedShard, element: elementTag },
      pinataMetadata: { name: `inaya_next_${elementTag}_${filename}` }
    };

    // Authenticating using Bearer JWT Token
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${pinataJWT.trim()}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();

      console.error("Pinata Error:", response.status, errorText);

      return NextResponse.json(
        {
          status: response.status,
          pinata: errorText,
        },
        { status: response.status }
      );
    }

    const data = await response.json();

    await replicateShardBestEffort({ fileHash, shardId, content: encryptedShard, primaryProvider: 'pinata', primaryCid: data.IpfsHash });

    return NextResponse.json({ IpfsHash: data.IpfsHash });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}