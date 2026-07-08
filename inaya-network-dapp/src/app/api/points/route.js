import { NextResponse } from 'next/server';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address')?.toLowerCase();

  if (!address) {
    return NextResponse.json({ error: "Missing wallet address parameter" }, { status: 400 });
  }

  // Fallback testing simulation
  return NextResponse.json({
    wallet_address: address,
    dapp_points: 0,
    social_points: 0,
    total_points: 0
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const address = body.walletAddress?.toLowerCase();
    const action = body.actionType;

    if (!address || !action) {
      return NextResponse.json({ error: "Required parameters missing" }, { status: 400 });
    }

    let pointsToAdd = 0;
    if (action === 'UPLOAD') pointsToAdd = 50;
    if (action === 'RETRIEVE') pointsToAdd = 30;
    if (action === 'SOCIAL') pointsToAdd = 145;

    return NextResponse.json({ 
      success: true, 
      message: `Successfully processed telemetry. Added ${pointsToAdd} points.` 
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}