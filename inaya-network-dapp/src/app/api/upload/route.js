import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';
import { replicateShard } from '@/lib/backupEngine';

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
    
    // 🔑 Updated to use Pinata JWT (Modern Method)
    const pinataJWT = process.env.PINATA_JWT;
    
    if (!pinataJWT) {
      return NextResponse.json({ error: "System Error: Server missing PINATA_JWT environment token." }, { status: 500 });
    }

    // 🔒 MONGO-BACKED B2B SUBSCRIPTION CHECK SYSTEM
    if (walletAddress) {
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