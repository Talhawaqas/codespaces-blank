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

    // 1. Fetch current points data object state
    const { data: user, error: fetchError } = await supabase
      .from('user_points')
      .select('*')
      .eq('wallet_address', address)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

    // Point Matrix configuration
    let pointsToAdd = 0;
    let isSocial = false;

    if (actionType === 'SIGNUP') pointsToAdd = 50;
    if (actionType === 'UPLOAD') pointsToAdd = 100;
    if (actionType === 'RETRIEVE') pointsToAdd = 20;
    
    // ========================================================
    // 🛡️ ANTI-DUPLICATION & SYBIL SECURITY SHIELD FOR SOCIALS
    // ========================================================
    if (actionType === 'SOCIAL') { 
      if (!handle || handle.trim() === '') {
        return NextResponse.json({ error: "Validation Core Error: Fill social reference mapping tag." }, { status: 400 });
      }

      const cleanHandle = handle.trim();

      // Check 1: Kya kisi aur wallet node ne yeh handle pehle se use kiya hua hai?
      const { data: handleTaken } = await supabase
        .from('user_points')
        .select('wallet_address')
        .eq('social_handle', cleanHandle)
        .not('wallet_address', 'eq', address) // Kisi doosre wallet par mapping check karega
        .maybeSingle();

      if (handleTaken) {
        return NextResponse.json({ error: "Duplication Core Error: This handle is already mapped to another wallet matrix node!" }, { status: 400 });
      }

      // Check 2: Kya is current wallet address ne pehle se hi social points claim kiye hue hain?
      if (user && user.social_handle) {
        return NextResponse.json({ error: "Pipeline Lock: This node index has already synchronized a social identifier asset." }, { status: 400 });
      }

      pointsToAdd = 145; 
      isSocial = true; 
    }

    // Mathematical accumulation matrices
    const currentDapp = user?.dapp_points || 0;
    const currentSocial = user?.social_points || 0;

    const nextDapp = isSocial ? currentDapp : currentDapp + pointsToAdd;
    const nextSocial = isSocial ? currentSocial + pointsToAdd : currentSocial;
    const nextTotal = nextDapp + nextSocial;

    // 2. Upsert updated state vector into table registers
    const { error: upsertError } = await supabase
      .from('user_points')
      .upsert(
        {
          wallet_address: address,
          dapp_points: nextDapp,
          social_points: nextSocial,
          total_points: nextTotal,
          social_handle: isSocial ? handle.trim() : user?.social_handle || null,
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