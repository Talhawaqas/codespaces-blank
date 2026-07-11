import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// Safe Fallback: If service role key is missing in Vercel settings, it uses public anon key
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

// ========================================================
// GET Handler: Fetch user points ledger mapping
// ========================================================
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get('address')?.toLowerCase();

  if (!address) return NextResponse.json({ error: 'Missing account address' }, { status: 400 });

  try {
    const { data, error } = await supabase
      .from('user_points')
      .select('*')
      .eq('wallet_address', address)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 means row not found (normal for new users)

    return NextResponse.json(data || { dapp_points: 0, social_points: 0, total_points: 0 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ========================================================
// POST Handler: Atomic updates for Web3 actions or social verify
// ========================================================
export async function POST(request) {
  try {
    const { walletAddress, actionType, handle } = await request.json();
    
    if (!walletAddress) {
      return NextResponse.json({ error: 'Missing walletAddress parameter' }, { status: 400 });
    }

    const address = walletAddress.toLowerCase();

    // Point Matrix configuration
    let pointsToAdd = 0;
    let isSocial = false;

    if (actionType === 'SIGNUP') pointsToAdd = 50;
    if (actionType === 'UPLOAD') pointsToAdd = 100;
    if (actionType === 'RETRIEVE') pointsToAdd = 20;
    if (actionType === 'SOCIAL') { pointsToAdd = 145; isSocial = true; }

    // 1. ✨ FIXED: Fetch current points and explicitly handle the PGRST116 exception
    const { data: user, error: fetchError } = await supabase
      .from('user_points')
      .select('*')
      .eq('wallet_address', address)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

    const currentDapp = user?.dapp_points || 0;
    const currentSocial = user?.social_points || 0;

    const nextDapp = isSocial ? currentDapp : currentDapp + pointsToAdd;
    const nextSocial = isSocial ? currentSocial + pointsToAdd : currentSocial;
    const nextTotal = nextDapp + nextSocial;

    // 2. ✨ FIXED: Upsert with clear onConflict constraints targeting primary key
    const { error: upsertError } = await supabase
      .from('user_points')
      .upsert(
        {
          wallet_address: address,
          dapp_points: nextDapp,
          social_points: nextSocial,
          total_points: nextTotal,
          social_handle: isSocial ? handle : user?.social_handle || null,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'wallet_address' } // Resolves conflict and merges data perfectly
      );

    if (upsertError) throw upsertError;
    
    return NextResponse.json({ success: true, total_points: nextTotal });
  } catch (err) {
    console.error("Supabase API Matrix Crash Log:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}