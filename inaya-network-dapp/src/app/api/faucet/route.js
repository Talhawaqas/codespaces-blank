import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getClientIp } from '../../../lib/ipAddress.js';
import {
  recordFaucetRequest,
  getTotalInayaSentToWallet,
  isNewFaucetWallet,
  getUniqueWalletCount,
  FAUCET_INAYA_LIFETIME_CAP,
  FAUCET_MAX_UNIQUE_WALLETS,
} from '../../../lib/faucet.js';

const RPC_URL = process.env.BNB_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545/";
const FAUCET_PRIVATE_KEY = process.env.FAUCET_PRIVATE_KEY;

const INAYA_TOKEN_ADDRESS = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e";
const USDT_TOKEN_ADDRESS = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) public returns (bool)",
  "function balanceOf(address account) public view returns (uint256)",
  "function decimals() public view returns (uint8)"
];

const INAYA_DRIP_AMOUNT = "500";
const USDT_DRIP_AMOUNT = "100";
const USDT_SUFFICIENCY_THRESHOLD = "20";
// $INAYA dispensing is gated by the tracked lifetime cap + wallet-count
// cap below (see lib/faucet.js), not an on-chain balance check — a
// balance check can't distinguish "already got the full allowance and
// spent it" from "never requested." mUSDT keeps the simpler
// balance-threshold top-up behavior since it isn't part of this cap.

export async function POST(request) {
  try {
    if (!FAUCET_PRIVATE_KEY) {
      return NextResponse.json(
        { success: false, error: "Faucet is not configured on the server (missing FAUCET_PRIVATE_KEY)." },
        { status: 500 }
      );
    }

    const { walletAddress } = await request.json();
    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      return NextResponse.json({ success: false, error: "Invalid wallet address." }, { status: 400 });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const treasury = new ethers.Wallet(FAUCET_PRIVATE_KEY, provider);

    const inayaToken = new ethers.Contract(INAYA_TOKEN_ADDRESS, ERC20_ABI, treasury);
    const usdtToken = new ethers.Contract(USDT_TOKEN_ADDRESS, ERC20_ABI, treasury);

    const results = {};

    const alreadyReceivedInaya = await getTotalInayaSentToWallet(walletAddress);

    if (alreadyReceivedInaya >= FAUCET_INAYA_LIFETIME_CAP) {
      results.inaya = { sent: false, reason: `This wallet has already received its maximum test $INAYA allowance (${FAUCET_INAYA_LIFETIME_CAP}).` };
    } else if ((await isNewFaucetWallet(walletAddress)) && (await getUniqueWalletCount()) >= FAUCET_MAX_UNIQUE_WALLETS) {
      // Global capacity only gates NEW wallets — a wallet that's already
      // received something before can still top up to its own cap even
      // once the faucet is "full" to new participants.
      results.inaya = { sent: false, reason: `The testnet faucet has reached its capacity of ${FAUCET_MAX_UNIQUE_WALLETS} wallets.` };
    } else {
      const inayaDecimals = await inayaToken.decimals();
      const remaining = FAUCET_INAYA_LIFETIME_CAP - alreadyReceivedInaya;
      const dripAmountStr = String(Math.min(remaining, parseFloat(INAYA_DRIP_AMOUNT)));
      const dripAmount = ethers.parseUnits(dripAmountStr, inayaDecimals);
      const tx = await inayaToken.transfer(walletAddress, dripAmount);
      await tx.wait();
      results.inaya = { sent: true, amount: dripAmountStr, txHash: tx.hash };
    }

    const usdtDecimals = await usdtToken.decimals();
    const usdtBalance = await usdtToken.balanceOf(walletAddress);
    const usdtThreshold = ethers.parseUnits(USDT_SUFFICIENCY_THRESHOLD, usdtDecimals);

    if (usdtBalance < usdtThreshold) {
      const dripAmount = ethers.parseUnits(USDT_DRIP_AMOUNT, usdtDecimals);
      const tx = await usdtToken.transfer(walletAddress, dripAmount);
      await tx.wait();
      results.usdt = { sent: true, amount: USDT_DRIP_AMOUNT, txHash: tx.hash };
    } else {
      results.usdt = { sent: false, reason: "Wallet already holds sufficient mUSDT for testing." };
    }

    // Awaited (not fire-and-forget) — a serverless function can freeze
    // right after the response is sent, same reasoning as everywhere
    // else in this codebase that writes tracking data before returning.
    // recordFaucetRequest() itself never throws (fail-open), so this
    // can't turn a successful dispatch into a failed response.
    await recordFaucetRequest({ walletAddress, ipAddress: getClientIp(request), results });

    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error("Faucet dispatch error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Faucet dispatch failed." },
      { status: 500 }
    );
  }
}
