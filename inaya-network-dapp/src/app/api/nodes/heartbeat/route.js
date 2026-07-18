import { NextResponse } from 'next/server';
import clientPromise from '../../../../lib/mongodb';

export async function POST(request) {
  try {
    const { nodeId, operatorWallet, usedCapacityGB, totalCapacityGB, shardsStored } = await request.json();
    if (!nodeId) {
      return NextResponse.json({ success: false, error: 'nodeId is required.' }, { status: 400 });
    }
    const client = await clientPromise;
    const db = client.db('inaya_network');
    const nodes = db.collection('nodes');
    const shardQueue = db.collection('shard_queue');
    const now = new Date();
    const updateFields = {
      usedCapacityGB: usedCapacityGB ?? 0,
      totalCapacityGB: totalCapacityGB ?? 0,
      shardsStored: shardsStored ?? 0,
      lastHeartbeatAt: now,
    };
    if (operatorWallet) updateFields.operatorWallet = operatorWallet.toLowerCase();
    await nodes.updateOne({ nodeId }, { $set: updateFields }, { upsert: true });
    const remainingGB = (totalCapacityGB ?? 0) - (usedCapacityGB ?? 0);
    const result = await shardQueue.findOneAndUpdate(
      { status: 'queued', sizeGB: { $lte: remainingGB } },
      { $set: { status: 'assigned', assignedTo: nodeId, assignedAt: now } },
      { sort: { queuedAt: 1 }, returnDocument: 'after' }
    );
    const pendingShard = result?.value || result;
    return NextResponse.json({
      success: true,
      pendingAssignment: pendingShard ? { shardId: pendingShard.shardId, sizeGB: pendingShard.sizeGB } : null,
    });
  } catch (err) {
    console.error('Heartbeat error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
