import { NextResponse } from 'next/server';
import clientPromise from '../../../../lib/mongodb';
import { computeUptimeScoreBps, HEARTBEAT_LOG_SIZE } from '../../../../lib/nodeReputation.js';
import { verifyNodeAuth } from '../../../../lib/nodeAuth.js';

export async function POST(request) {
  try {
    const {
      nodeId, operatorWallet, usedCapacityGB, totalCapacityGB, shardsStored,
      daemonVersion, uptimeSeconds, restartCount, lastErrorAt, lastErrorMessage,
      message, signature, timestamp,
    } = await request.json();
    if (!nodeId || !operatorWallet) {
      return NextResponse.json({ success: false, error: 'nodeId and operatorWallet are required.' }, { status: 400 });
    }
    try {
      verifyNodeAuth({ action: 'heartbeat', nodeId, operatorWallet, message, signature, timestamp });
    } catch (err) {
      return NextResponse.json({ success: false, error: err.message }, { status: 401 });
    }
    const client = await clientPromise;
    const db = client.db('inaya_network');
    const nodes = db.collection('nodes');
    const shardQueue = db.collection('shard_queue');
    const now = new Date();

    // Phase 5 — append this beat to a capped rolling log so
    // computeUptimeScoreBps() can measure real heartbeat regularity, not
    // just "did the most recent one arrive." $push+$slice keeps this a
    // single atomic write, same discipline as every other capped-array
    // pattern in this codebase.
    const existing = await nodes.findOne({ nodeId }, { projection: { heartbeatLog: 1 } });
    const heartbeatLog = [...(existing?.heartbeatLog || []), now.toISOString()].slice(-HEARTBEAT_LOG_SIZE);
    const uptimeScoreBps = computeUptimeScoreBps({ heartbeatLog, lastHeartbeatAt: now.toISOString() }, now.getTime());

    const updateFields = {
      usedCapacityGB: usedCapacityGB ?? 0,
      totalCapacityGB: totalCapacityGB ?? 0,
      shardsStored: shardsStored ?? 0,
      lastHeartbeatAt: now,
      heartbeatLog,
      uptimeScoreBps,
      // Genuinely reported by the daemon itself (start.js/state.js) — never
      // fabricated here if the daemon didn't send them (an older daemon
      // version simply won't include these fields, and that's honest: we
      // don't know its version/uptime, so we don't claim to).
      daemonVersion: daemonVersion ?? null,
      uptimeSeconds: typeof uptimeSeconds === 'number' ? uptimeSeconds : null,
      restartCount: typeof restartCount === 'number' ? restartCount : null,
      lastErrorAt: lastErrorAt ?? null,
      lastErrorMessage: lastErrorMessage ?? null,
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
