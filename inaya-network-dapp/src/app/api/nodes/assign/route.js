// src/app/api/nodes/assign/route.js
//
// Picks a real, eligible node operator from your existing Mongo node registry
// (the same collection /api/nodes/register, /heartbeat, /list, /queue-shard use)
// instead of hardcoding the uploader's own wallet or a placeholder pool address.
//
// ⚠️ FIELD NAME ASSUMPTION: this reads `operatorWallet`, `declaredCapacityGB`,
// `usedCapacityGB`, `uptimeScoreBps`, `lastHeartbeatAt`, `active`, `tier` from a
// `nodes` collection. If your actual schema from /api/nodes/register uses different
// field names, it's a find-replace in the block below — the selection logic itself
// doesn't need to change.
//
// Selection strategy: filter to nodes that are (1) active, (2) heartbeated within
// the last 24h, (3) at/above the 90% uptime gate from your Manifesto, (4) have
// enough free capacity, and (5) meet the requested minimum tier. Among survivors,
// pick the one with the MOST free capacity (greedy bin-packing — naturally spreads
// load away from nearly-full nodes), tie-broken by highest uptime score.

import clientPromise from '@/lib/mongodb';
import { NextResponse } from 'next/server';

const UPTIME_THRESHOLD_BPS = 9000;              // 90% gate, matches your Operator Manifesto
const HEARTBEAT_STALE_MS = 24 * 60 * 60 * 1000; // node considered offline beyond this

function tierRank(tier) {
  if (tier === 'Enterprise') return 2;
  if (tier === 'Mid') return 1;
  return 0; // Entry
}

export async function POST(request) {
  try {
    const body = await request.json();
    const {
      requiredCapacityGB = 1,
      minTier = 'Entry',           // 'Entry' | 'Mid' | 'Enterprise'
      excludeWallet = null,         // don't assign a customer's own wallet to itself
      fallbackWallet = null         // bootstrap operator wallet, used if no real operator qualifies yet
    } = body;

    if (!requiredCapacityGB || requiredCapacityGB <= 0) {
      return NextResponse.json({ error: 'requiredCapacityGB must be a positive number.' }, { status: 400 });
    }

    const client = await clientPromise;
    const db = client.db();
    const nodes = db.collection('nodes'); // adjust if your collection is named differently

    const now = Date.now();
    const candidates = await nodes.find({ active: true }).toArray();

    const eligible = candidates.filter((n) => {
      const heartbeatFresh = n.lastHeartbeatAt && (now - new Date(n.lastHeartbeatAt).getTime()) < HEARTBEAT_STALE_MS;
      const uptimeOk = (n.uptimeScoreBps ?? 10000) >= UPTIME_THRESHOLD_BPS;
      const available = (n.declaredCapacityGB || 0) - (n.usedCapacityGB || 0);
      const capacityOk = available >= requiredCapacityGB;
      const tierOk = tierRank(n.tier || 'Entry') >= tierRank(minTier);
      const notExcluded = excludeWallet ? n.operatorWallet?.toLowerCase() !== excludeWallet.toLowerCase() : true;
      return heartbeatFresh && uptimeOk && capacityOk && tierOk && notExcluded;
    });

    if (eligible.length === 0) {
      if (fallbackWallet) {
        return NextResponse.json({
          operatorWallet: fallbackWallet,
          endpoint: null,
          tier: 'Fallback',
          availableCapacityGB: null,
          isFallback: true,
          reason: 'No independent operators currently meet the eligibility criteria; assigned to the bootstrap operator.'
        });
      }
      return NextResponse.json(
        { error: 'No eligible node operators available for this request, and no fallbackWallet was provided.' },
        { status: 404 }
      );
    }

    eligible.sort((a, b) => {
      const availA = (a.declaredCapacityGB || 0) - (a.usedCapacityGB || 0);
      const availB = (b.declaredCapacityGB || 0) - (b.usedCapacityGB || 0);
      if (availB !== availA) return availB - availA;
      return (b.uptimeScoreBps || 0) - (a.uptimeScoreBps || 0);
    });

    const chosen = eligible[0];

    // Soft-reserve capacity immediately so two concurrent assignments in the same
    // second don't both land on the same node before the next heartbeat reconciles it.
    await nodes.updateOne(
      { _id: chosen._id },
      { $inc: { usedCapacityGB: requiredCapacityGB }, $set: { lastAssignedAt: new Date() } }
    );

    return NextResponse.json({
      operatorWallet: chosen.operatorWallet,
      endpoint: chosen.endpoint || null,
      tier: chosen.tier || 'Entry',
      availableCapacityGB: (chosen.declaredCapacityGB || 0) - (chosen.usedCapacityGB || 0) - requiredCapacityGB,
      isFallback: false
    });
  } catch (err) {
    console.error('Node assignment failed:', err);
    return NextResponse.json({ error: 'Assignment pipeline error.' }, { status: 500 });
  }
}
