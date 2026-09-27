import { NextResponse } from 'next/server';
import clientPromise from '../../../../lib/mongodb.js';
import { verifyMetadataAuth } from '../../../../lib/metadata-auth.js';
import { checkRateLimit } from '../../../../lib/rateLimit.js';

export async function POST(request) {
  try {
    const { shardId, sizeGB, address, message, signature, timestamp } = await request.json();
    if (!shardId || typeof shardId !== 'string' || shardId.length > 200 || typeof sizeGB !== 'number' || !Number.isFinite(sizeGB) || sizeGB <= 0 || sizeGB > 1000) {
      return NextResponse.json(
        { success: false, error: 'shardId and sizeGB (number) are required.' },
        { status: 400 }
      );
    }
    // SQA (S2): anyone could fill the shard queue. The caller must prove control of a wallet and is rate limited.
    try {
      verifyMetadataAuth({ action: 'queueShard', resourceId: shardId, extra: { sizeGB }, address, message, signature, timestamp });
    } catch (err) {
      return NextResponse.json({ success: false, error: err.message }, { status: 401 });
    }
    try {
      await checkRateLimit({ action: 'nodes:queue-shard', key: String(address).toLowerCase(), max: 300, windowMs: 60 * 60 * 1000 });
    } catch (err) {
      return NextResponse.json({ success: false, error: err.message }, { status: 429 });
    }
    const client = await clientPromise;
    const db = client.db('inaya_network');
    const shardQueue = db.collection('shard_queue');
    const existing = await shardQueue.findOne({ shardId });
    if (existing) {
      return NextResponse.json({ success: true, message: 'Shard already queued or assigned.', shard: existing });
    }
    const shard = { shardId, sizeGB, status: 'queued', queuedAt: new Date(), assignedTo: null };
    await shardQueue.insertOne(shard);
    return NextResponse.json({ success: true, shard });
  } catch (err) {
    console.error('Queue shard error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
