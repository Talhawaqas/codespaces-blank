"use client";

// src/lib/firebaseClient.js
//
// Client-side Firebase app init for Phone Auth — SAFE to be public. This
// config (apiKey, authDomain, etc.) is not a secret; Firebase's own
// security model relies on server-side rule/App Check enforcement, not on
// hiding this object, the same reason NEXT_PUBLIC_GOOGLE_CLIENT_ID is
// already exposed client-side elsewhere in this app. The real secret
// (the service-account private key) lives only in firebaseAdmin.js,
// server-side, never sent to the browser.

import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId);
}

export function getFirebaseAuth() {
  if (!isFirebaseConfigured()) throw new Error("Firebase isn't configured yet — set NEXT_PUBLIC_FIREBASE_* in .env.local.");
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  return getAuth(app);
}
