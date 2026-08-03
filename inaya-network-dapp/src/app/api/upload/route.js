import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/lib/mongodb';

export async function POST(request) {
  try {
    const body = await request.json();
    const { encryptedShard, filename, elementTag, walletAddress, selectedTier } = body;
    
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
    return NextResponse.json({ IpfsHash: data.IpfsHash });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}