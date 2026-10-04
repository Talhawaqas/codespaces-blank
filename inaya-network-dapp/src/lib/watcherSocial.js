// src/lib/watcherSocial.js
//
// Social login for the Watcher Pioneer Program, alongside (never instead of) wallet participation.
//
// DESIGN RULE: purely additive. Every existing participant is a wallet-keyed record in watcher_pioneers, with sessions in watcher_sessions
// keyed by the same wallet. None of that is read differently, rewritten, re-keyed or migrated here:
//   * A social participant is the SAME kind of record, keyed by a synthetic id ("social:google:<subject>", which can never equal a real
//     0x address), so enrollment, the 2,500 cap, the 24h sessions, points, the 100,000-point lifetime cap, compensation grants and backups all
//     work for them unchanged.
//   * watcher_identities maps a verified login (provider + the provider's stable subject id, not the email) to the participant it controls.
//   * watcher_wallet_links lets a social participant add a wallet (for the upload path and for receiving rewards).
//   * An EXISTING wallet participant can attach a login to their wallet record: the login then resolves to that same wallet record, so the
//     person keeps their points and sessions and can sign in either way.
// One person must not become two participants, and records are never merged: if a wallet that already has its own participant record is
// linked to a social participant (or the reverse), the link is refused with a clear message, because merging would mean moving points.

import { OAuth2Client } from "google-auth-library";
import { getWatcherCollections, normalizeWallet, enrollWallet, startSession, getPioneerStatus, verifyWatcherAuth } from "./watcherPioneer.js";
import { verifySession as verifyTelegramSession, isGroupMember, groupCheckEnabled } from "./watcherTelegram.js";

export const SOCIAL_PROVIDERS = ["google", "telegram"];

// ------------------------------------------------------------------------------------------------ verifying a login
const client = new OAuth2Client();
let verifierOverride = null;
/** Test hook: replaces the real provider verification so tests never need a real Google account. */
export function __setSocialVerifier(fn) { verifierOverride = fn; }

/** Returns { provider, subject, email, name } for a valid provider token, or throws. The subject (Google's stable "sub") is the identity: an
 *  email address can change or be recycled, the subject cannot. */
export async function verifySocialLogin({ provider = "google", idToken }) {
  if (!SOCIAL_PROVIDERS.includes(provider)) throw new Error(`Unsupported login provider "${provider}".`);
  if (!idToken || typeof idToken !== "string") throw new Error("Missing login token.");
  if (verifierOverride) return verifierOverride({ provider, idToken });
  if (provider === "telegram") { // our own signed session (see watcherTelegram.js); throws if invalid or expired
    const s = verifyTelegramSession(idToken);
    return { provider: "telegram", subject: s.subject, email: null, name: s.name };
  }
  const audience = [process.env.GOOGLE_CLIENT_ID].filter(Boolean);
  if (!audience.length) throw new Error("Google sign-in isn't configured on this server.");
  const ticket = await client.verifyIdToken({ idToken, audience });
  const p = ticket.getPayload();
  if (!p?.sub) throw new Error("The Google token has no account id.");
  if (!p.email_verified) throw new Error("Google account email isn't verified.");
  return { provider: "google", subject: String(p.sub), email: (p.email || "").toLowerCase(), name: p.name || null };
}

export const socialKey = (provider, subject) => `social:${provider}:${String(subject)}`.toLowerCase();
export const isSocialKey = (k) => typeof k === "string" && k.startsWith("social:");

// ------------------------------------------------------------------------------------------------ indexes (new collections only)
let ensured = false;
export async function ensureSocialIndexes() {
  if (ensured) return;
  const { identities, walletLinks } = await getWatcherCollections();
  await Promise.all([
    identities.createIndex({ provider: 1, subject: 1 }, { unique: true }),
    identities.createIndex({ participantKey: 1 }, { unique: true }), // one login per participant: a record cannot be shared between accounts
    walletLinks.createIndex({ walletAddress: 1 }, { unique: true }),   // a wallet links to at most one social participant
    walletLinks.createIndex({ participantKey: 1 }, { unique: true }),  // and a social participant to at most one wallet
  ]);
  ensured = true;
}

const fail = (message, status = 409) => Object.assign(new Error(message), { status });

// ------------------------------------------------------------------------------------------------ resolving who a login is
/** The participant record this login controls, or null if it has none yet. */
export async function findParticipant(login) {
  const { identities, pioneers } = await getWatcherCollections();
  const identity = await identities.findOne({ provider: login.provider, subject: login.subject });
  if (!identity) return { identity: null, participantKey: null, pioneer: null };
  return { identity, participantKey: identity.participantKey, pioneer: await pioneers.findOne({ walletAddress: identity.participantKey }) };
}

/** The wallet a participant can use for on-chain actions: their own key if it is a wallet, or the wallet linked to a social participant. */
export async function walletOf(participantKey) {
  if (!isSocialKey(participantKey)) return participantKey;
  const { walletLinks } = await getWatcherCollections();
  return (await walletLinks.findOne({ participantKey }))?.walletAddress || null;
}

/** Refuses a wallet-signed enrollment for a wallet that is linked to a social participant (it would create a second record for one person). */
export async function assertWalletNotLinked(walletAddress) {
  const { walletLinks } = await getWatcherCollections();
  if (await walletLinks.findOne({ walletAddress: normalizeWallet(walletAddress) })) {
    throw fail("This wallet is linked to a social-login account. Sign in with that account instead of enrolling the wallet separately.");
  }
}

// ------------------------------------------------------------------------------------------------ enrolling and playing
export async function enrollSocial({ login, followedX, joinedTelegram }) {
  await ensureSocialIndexes();
  const { identities } = await getWatcherCollections();
  const existing = await findParticipant(login);
  if (existing.identity) {
    if (!existing.pioneer) throw fail("This login is linked to a participant record that could not be found. Please contact support.", 500);
    return { pioneer: existing.pioneer, alreadyEnrolled: true, participantKey: existing.participantKey };
  }
  const participantKey = socialKey(login.provider, login.subject);
  // Telegram: when the bot can see the group, "joined Telegram" is checked, not just attested. Not a member -> a clear message and nothing is created.
  if (login.provider === "telegram" && groupCheckEnabled()) {
    if ((await isGroupMember(login.subject)) !== true) throw fail("Join the Inaya Telegram group first, then try again.");
    joinedTelegram = true;
  }
  // Same enrollment as a wallet: self-attested X + Telegram, the shared 2,500 cap, the same promo. Idempotent, so a retry after a failure
  // between these two writes finds the participant that was already created.
  const { pioneer, alreadyEnrolled } = await enrollWallet({ walletAddress: participantKey, followedX, joinedTelegram, extraFields: { loginProvider: login.provider } });
  await identities.updateOne(
    { provider: login.provider, subject: login.subject },
    { $setOnInsert: { provider: login.provider, subject: login.subject, email: login.email || null, name: login.name || null, participantKey, createdAt: new Date() } },
    { upsert: true },
  );
  return { pioneer, alreadyEnrolled, participantKey };
}

export async function startSocialSession({ login, method, qualifyingRef }) {
  const { identity, participantKey, pioneer } = await findParticipant(login);
  if (!identity || !pioneer) throw fail("This login isn't enrolled in the Watcher Pioneer Program yet.");
  let txWallet = null;
  if (method === "upload") {
    txWallet = await walletOf(participantKey);
    if (!txWallet) throw fail("Link a wallet to your account to use the upload qualifying action. Until then, use the social task.");
  }
  return startSession({ walletAddress: participantKey, qualifyingMethod: method, qualifyingRef, txWallet });
}

export async function getSocialStatus({ login }) {
  const { identity, participantKey } = await findParticipant(login);
  if (!identity) {
    const base = await getPioneerStatus(socialKey(login.provider, login.subject)); // not enrolled: reports spots remaining
    return { ...base, loginProvider: login.provider, linkedWallet: null };
  }
  const status = await getPioneerStatus(participantKey);
  const wallet = await walletOf(participantKey);
  return { ...status, loginProvider: login.provider, email: identity.email, linkedWallet: wallet, canReceiveRewards: !!wallet };
}

// ------------------------------------------------------------------------------------------------ linking a wallet and a login
/**
 * Proves control of BOTH sides (a fresh provider token and a wallet signature over the link request) and then connects them.
 *   * login already controls a social participant  -> that participant gets this wallet (refused if the wallet has its own record).
 *   * login has no participant, wallet has one      -> the login is attached to the wallet's record (points and sessions untouched).
 * Nothing is moved, merged or deleted. Anything that would put two records together is refused.
 */
export async function linkLoginToWallet({ login, walletAddress, message, signature, timestamp }) {
  await ensureSocialIndexes();
  const wallet = normalizeWallet(walletAddress);
  if (!wallet) throw fail("walletAddress is required.", 400);
  verifyWatcherAuth({ action: "link_social", extra: { provider: login.provider, subject: login.subject }, address: wallet, message, signature, timestamp });

  const { identities, pioneers, walletLinks } = await getWatcherCollections();
  const mine = await findParticipant(login);
  const walletPioneer = await pioneers.findOne({ walletAddress: wallet });
  const walletLink = await walletLinks.findOne({ walletAddress: wallet });

  if (mine.identity && !isSocialKey(mine.participantKey)) {
    if (mine.participantKey === wallet) return { linked: true, alreadyLinked: true, participantKey: wallet };
    throw fail("This login is already attached to a different wallet's account.");
  }
  if (mine.identity) { // login controls a social participant
    if (walletLink) {
      if (walletLink.participantKey === mine.participantKey) return { linked: true, alreadyLinked: true, participantKey: mine.participantKey, walletAddress: wallet };
      throw fail("That wallet is already linked to another account.");
    }
    if (walletPioneer) throw fail("That wallet already has its own Watcher account with its own points, so the two cannot be combined automatically. Sign in with the wallet, or choose a different wallet.");
    if (await walletLinks.findOne({ participantKey: mine.participantKey })) throw fail("Your account already has a wallet linked.");
    await walletLinks.insertOne({ walletAddress: wallet, participantKey: mine.participantKey, linkedAt: new Date() });
    return { linked: true, participantKey: mine.participantKey, walletAddress: wallet };
  }
  // login has no participant yet: attach it to the wallet's existing record
  if (!walletPioneer) throw fail("That wallet isn't enrolled in the Watcher Pioneer Program. Enroll first, or sign in with the login to enroll through it.");
  if (walletLink) throw fail("That wallet is linked to a social-login account.");
  if (await identities.findOne({ participantKey: wallet })) throw fail("That wallet's account already has a login attached.");
  await identities.insertOne({ provider: login.provider, subject: login.subject, email: login.email || null, name: login.name || null, participantKey: wallet, createdAt: new Date(), attachedToWallet: true });
  return { linked: true, attached: true, participantKey: wallet };
}
