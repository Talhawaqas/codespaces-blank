import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

// Yeh line Next.js ko build time par static generation karne se rokegi
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const client = await clientPromise;
    if (!client) {
      throw new Error('Database client undefined during execution');
    }
    const db = client.db('inaya_network');
    const nodes = await db.collection('nodes').find({}).sort({ registeredAt: -1 }).toArray();
    return NextResponse.json({ success: true, count: nodes.length, nodes });
  } catch (err) {
    console.error('List nodes error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
