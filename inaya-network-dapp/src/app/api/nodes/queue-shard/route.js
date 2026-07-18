import { NextResponse } from 'next/server';
import clientPromise from '../../../../lib/mongodb';

export async function POST(request) {
  try {
    const { shardId, sizeGB } = await request.json();
    if (!shardId || typeof sizeGB !== 'number') {
      return NextResponse.json(
        { success: false, error: 'shardId and sizeGB (number) are required.' },
        { status: 400 }
      );
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
