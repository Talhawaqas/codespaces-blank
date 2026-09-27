import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

// Yeh line Next.js ko build time par static generation karne se rokegi
export const dynamic = 'force-dynamic';

const PUBLIC_NODE_FIELDS = { _id: 0, nodeId: 1, operatorWallet: 1, tier: 1, totalCapacityGB: 1, usedCapacityGB: 1, shardsStored: 1, uptimeScoreBps: 1, acceptingNewShards: 1, registeredAt: 1, lastHeartbeatAt: 1 };

export async function GET() {
  try {
    const client = await clientPromise;
    if (!client) {
      throw new Error('Database client undefined during execution');
    }
    const db = client.db('inaya_network');
    // SQA-013 (S3): this public route returned every stored field of every node (heartbeat logs, daemon error messages, restart counts...), while
    // its sibling /api/nodes/operator/network promises never to expose another operator's private telemetry. Only the public listing fields remain.
    const nodes = await db.collection('nodes').find({}, { projection: PUBLIC_NODE_FIELDS }).sort({ registeredAt: -1 }).limit(1000).toArray();
    return NextResponse.json({ success: true, count: nodes.length, nodes });
  } catch (err) {
    console.error('List nodes error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
