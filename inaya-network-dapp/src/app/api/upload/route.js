import { NextResponse } from 'next/server';

export async function POST(request) {
  try {
    const body = await request.json();
    const { encryptedShard, filename, elementTag } = body;
    
    // Server-side environment tokens pulled directly from your Vercel Dashboard
    const apiKey = process.env.PINATA_API_KEY;
    const apiSecret = process.env.PINATA_SECRET_API_KEY;
    
    if (!apiKey || !apiSecret) {
      return NextResponse.json({ error: "System Error: Server missing environment tokens." }, { status: 500 });
    }

    const url = "https://api.pinata.cloud/pinning/pinJSONToIPFS";
    const payload = {
      pinataContent: { shard: encryptedShard, element: elementTag },
      pinataMetadata: { name: `inaya_next_${elementTag}_${filename}` }
    };

    // Authenticating using API Key + Secret Key headers instead of missing JWT
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "pinata_api_key": apiKey.trim(),
        "pinata_secret_api_key": apiSecret.trim()
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Decentralized IPFS Node transmission rejected." }, { status: 500 });
    }

    const data = await response.json();
    return NextResponse.json({ IpfsHash: data.IpfsHash });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}