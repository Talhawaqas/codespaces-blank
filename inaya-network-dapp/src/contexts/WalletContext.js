"use client";

// src/contexts/WalletContext.js
//
// Enterprise OS SOW, Phase 1 — the dApp's equivalent of OrgContext.js.
// Before this, src/app/page.js's single ~7500-line Home() component held
// walletAddress/walletBalance/isConnected/selectedWalletName/isWrongNetwork
// as plain useState (line ~2418) with no way for a component below it to
// read wallet identity without a prop being threaded down. This context
// owns the exact same state (moved, not duplicated) plus a signMessage()
// helper wrapping the same `new ethers.BrowserProvider(getActiveProvider())`
// pattern already repeated at ~20 call sites in page.js — new Phase 2+
// wallet-scoped code (Trust/Health, Notifications, Search, the OS AI
// router) calls useWallet().signMessage() instead of duplicating that
// three-line pattern again.
//
// Deliberately NOT touching any of Home()'s existing wallet-connection
// call sites — those keep constructing their own BrowserProvider inline
// exactly as they do today. This context is additive: new code reads
// wallet identity through it, old code is untouched.

import { createContext, useContext, useMemo } from "react";

const WalletContext = createContext(null);

export function WalletProvider({
  children,
  walletAddress,
  walletBalance,
  isConnected,
  selectedWalletName,
  isWrongNetwork,
  signMessage,
}) {
  const value = useMemo(
    () => ({
      walletAddress,
      walletBalance,
      isConnected,
      selectedWalletName,
      isWrongNetwork,
      signMessage,
    }),
    [walletAddress, walletBalance, isConnected, selectedWalletName, isWrongNetwork, signMessage]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Throws if called outside a WalletProvider — same fail-loud convention
 *  as useOrg(), so a wiring mistake surfaces immediately in dev. */
export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet() must be called within a WalletProvider (the main dApp only).");
  return ctx;
}
