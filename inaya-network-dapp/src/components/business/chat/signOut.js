"use client";

// src/components/business/chat/signOut.js
//
// Secure sign-out for Secure Chat. What signing out does to the chat data on THIS device is an organization policy (chat settings, signOutPolicy):
//   keep   : nothing (the default; the sealed local data stays so the next sign-in opens quickly)
//   clear  : erase the readable history on this device (messages and unsent drafts); the device keeps its keys and stays a working member
//   revoke : revoke this device on the server and erase everything local; signing in again enrolls a new device that sees only new messages
// The server never sees plaintext either way. This only decides what stays on the machine.

let live = null; // { client } while Secure Chat is running in this window

export const registerLiveChat = (client) => { live = client ? { client } : null; };

async function openRaw(orgId, email) {
  const [{ HttpChatApi }, { openBrowserStore }] = await Promise.all([import("../../../lib/chat/client/httpApi.js"), import("../../../lib/chat/client/stores.js")]);
  return { api: new HttpChatApi({ orgId }), openBrowserStore, key: `${orgId}:${email}` };
}

/** Applies the organization's sign-out policy. Never throws; returns what it did so the caller can say so. */
export async function applyChatSignOutPolicy({ orgId, email }) {
  try {
    if (!orgId || !email) return { applied: "none" };
    const { api, openBrowserStore, key } = await openRaw(orgId, email);
    let policy = "keep";
    try { policy = (await api.chatSettings()).signOutPolicy || "keep"; } catch (e) { if (e.status === 404 || e.status === 403) return { applied: "none" }; throw e; }
    if (policy === "keep") return { applied: "keep" };
    const client = live?.client;
    if (!client && typeof indexedDB !== "undefined" && indexedDB.databases) { const dbs = await indexedDB.databases(); if (!dbs.some((d) => d.name === `inaya-chat:${key}`)) return { applied: "none" }; } // no chat on this device: do not create an empty store
    const store = client ? client.store : await openBrowserStore(key);
    const device = client ? client.device : await store.get("device");
    let revoked = false;
    if (policy === "revoke" && device?.deviceId) { try { api.setDevice(device.deviceId); await api.revokeDevice(device.deviceId); revoked = true; } catch { /* already revoked or unreachable: still erase locally */ } }
    if (policy === "revoke") { if (client) await client.wipeLocal(); else await store.clear(); }
    else if (client) await client.clearCache(); else for (const p of ["msgs:", "outbox:"]) for (const k of await store.keys(p)) await store.delete(k);
    return { applied: policy, revoked };
  } catch { return { applied: "error" }; }
}
