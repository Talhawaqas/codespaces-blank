"use client";

// src/components/business/chat/desktop.js
//
// What the web app needs to know about running inside the Inaya Business Workspace desktop app (a Tauri window around this same site).
// window.__TAURI__ exists only there, so every helper is a no-op in an ordinary browser tab.

export const isDesktopApp = () => typeof window !== "undefined" && !!window.__TAURI__;

/** Platform names the chat server accepts for a device: web, windows, macos, linux. */
export function devicePlatform() {
  if (!isDesktopApp()) return "web";
  const s = `${navigator.userAgentData?.platform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
  if (s.includes("win")) return "windows";
  if (s.includes("mac")) return "macos";
  if (s.includes("linux") || s.includes("x11")) return "linux";
  return "web";
}

export const deviceLabel = () => (isDesktopApp() ? "Desktop app" : "Web browser");

/** Calls a native command; resolves to null (never throws) when not in the desktop app or the command fails. */
export async function native(command, args = {}) {
  if (!isDesktopApp()) return null;
  try { return await window.__TAURI__.core.invoke(command, args); } catch { return null; }
}

/** Opens Secure Chat in its own native window (the open_module_window command the desktop app already has). */
export const popOutChat = () => native("open_module_window", { label: "chat", path: "/business?view=chat" });

/** Opens Inaya Meet in its own native window -- same existing open_module_window command, no new
 *  native code (Internxt-inspired SOW §7.31: "Do not create a fifth native application"). Meet's
 *  meeting window is just this web UI in a separate Tauri window, identical to how chat pops out. */
export const popOutMeet = () => native("open_module_window", { label: "meet", path: "/business?view=meet" });

/** Opens a specific Meet join link in its own native window -- used for "New Meeting"/"Join
 *  Meeting" from the desktop app so the meeting runs in its own window from the start. */
export const openMeetLink = (joinLink) => native("open_module_window", { label: `meet-${Date.now()}`, path: joinLink });
