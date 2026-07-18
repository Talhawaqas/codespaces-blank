import { NextResponse } from 'next/server';
import clientPromise from '../../../../lib/mongodb';

export async function POST(request) {
  try {
    const { nodeId, operatorWallet, capacityGB } = await request.json();
    if (!nodeId || !operatorWallet || !capacityGB) {
      return NextResponse.json(
        { success: false, error: 'nodeId, operatorWallet, and capacityGB are all required.' },
        { status: 400 }
      );
    }
    const client = await clientPromise;
    const db = client.db('inaya_network');
    const nodes = db.collection('nodes');
    const existing = await nodes.findOne({ nodeId });
    if (existing) {
      return NextResponse.json({ success: true, message: 'Node already registered.', node: existing });
    }
    const newNode = {
      nodeId,
      operatorWallet: operatorWallet.toLowerCase(),
      totalCapacityGB: capacityGB,
      usedCapacityGB: 0,
      shardsStored: 0,
      uptimeScoreBps: 0,
      tier: 'Entry',
      acceptingNewShards: true,
      registeredAt: new Date(),
      lastHeartbeatAt: null,
    };
    await nodes.insertOne(newNode);
    return NextResponse.json({ success: true, node: newNode });
  } catch (err) {
    console.error('Node registration error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
