import { NextResponse } from 'next/server';
import { ethers } from 'ethers';

const RPC_URL = process.env.BNB_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545/";
const FAUCET_PRIVATE_KEY = process.env.FAUCET_PRIVATE_KEY;

const INAYA_TOKEN_ADDRESS = "0x3966a3378c8d9e6bb34dd0b8458eef4b878ce94e";
const USDT_TOKEN_ADDRESS = "0x6f16E2d169B5F2c7141c2b46dD864f8daE01745D";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) public returns (bool)",
  "function balanceOf(address account) public view returns (uint256)",
  "function decimals() public view returns (uint8)"
];

const INAYA_DRIP_AMOUNT = "50000";
const USDT_DRIP_AMOUNT = "100";
const INAYA_SUFFICIENCY_THRESHOLD = "10000";
const USDT_SUFFICIENCY_THRESHOLD = "20";

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

    const inayaDecimals = await inayaToken.decimals();
    const inayaBalance = await inayaToken.balanceOf(walletAddress);
    const inayaThreshold = ethers.parseUnits(INAYA_SUFFICIENCY_THRESHOLD, inayaDecimals);

    if (inayaBalance < inayaThreshold) {
      const dripAmount = ethers.parseUnits(INAYA_DRIP_AMOUNT, inayaDecimals);
      const tx = await inayaToken.transfer(walletAddress, dripAmount);
      await tx.wait();
      results.inaya = { sent: true, amount: INAYA_DRIP_AMOUNT, txHash: tx.hash };
    } else {
      results.inaya = { sent: false, reason: "Wallet already holds sufficient $INAYA for testing." };
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

    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error("Faucet dispatch error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Faucet dispatch failed." },
      { status: 500 }
    );
  }
}
