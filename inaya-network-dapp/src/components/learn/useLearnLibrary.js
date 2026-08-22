// src/components/learn/useLearnLibrary.js
//
// Web port of inaya-mobile's useLearnLibrary hook — same local-first +
// optional wallet-sync design (localStorage here instead of AsyncStorage),
// same merge-by-videoId-on-connect logic. Backend calls use relative paths
// (/api/learn/*) since this runs same-origin, unlike the mobile app's
// cross-origin API_BASE fetches.

import { useState, useEffect, useRef, useCallback } from 'react';

const SAVED_KEY = 'inaya_learn_saved';
const PROGRESS_KEY = 'inaya_learn_progress';

function readLocal(key) {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocal(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort — local cache write failing shouldn't break the UI
  }
}

function mergeByVideoId(local, remote) {
  const map = new Map(local.map((v) => [v.videoId, v]));
  for (const r of remote) map.set(r.videoId, r); // backend wins on conflict
  return [...map.values()];
}

async function apiRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
  return data;
}

export function useLearnLibrary(walletAddress) {
  const [saved, setSaved] = useState([]);
  const [progress, setProgress] = useState([]);
  const [ready, setReady] = useState(false);
  const mergedForWallet = useRef(null);

  useEffect(() => {
    setSaved(readLocal(SAVED_KEY));
    setProgress(readLocal(PROGRESS_KEY));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready || !walletAddress) return;
    if (mergedForWallet.current === walletAddress) return;
    mergedForWallet.current = walletAddress;

    (async () => {
      try {
        const localSaved = readLocal(SAVED_KEY);
        const localProgress = readLocal(PROGRESS_KEY);
        const [remoteSavedRes, remoteProgressRes] = await Promise.all([
          apiRequest(`/api/learn/saved?walletAddress=${encodeURIComponent(walletAddress)}`),
          apiRequest(`/api/learn/progress?walletAddress=${encodeURIComponent(walletAddress)}`),
        ]);
        const remoteSaved = remoteSavedRes.items || [];
        const remoteProgress = remoteProgressRes.items || [];

        const mergedSaved = mergeByVideoId(localSaved, remoteSaved);
        const mergedProgress = mergeByVideoId(localProgress, remoteProgress);
        setSaved(mergedSaved);
        setProgress(mergedProgress);
        writeLocal(SAVED_KEY, mergedSaved);
        writeLocal(PROGRESS_KEY, mergedProgress);

        const remoteSavedIds = new Set(remoteSaved.map((r) => r.videoId));
        for (const item of localSaved) {
          if (!remoteSavedIds.has(item.videoId)) {
            apiRequest('/api/learn/saved', { method: 'POST', body: { walletAddress, ...item } }).catch(() => {});
          }
        }
      } catch {
        // Offline or backend hiccup — local state remains authoritative for this session.
      }
    })();
  }, [ready, walletAddress]);

  const isVideoSaved = useCallback((videoId) => saved.some((v) => v.videoId === videoId), [saved]);
  const getVideoProgress = useCallback((videoId) => progress.find((p) => p.videoId === videoId) || null, [progress]);

  const toggleSave = useCallback(async (video) => {
    const alreadySaved = saved.some((v) => v.videoId === video.videoId);
    const next = alreadySaved ? saved.filter((v) => v.videoId !== video.videoId) : [{ ...video, savedAt: new Date().toISOString() }, ...saved];
    setSaved(next);
    writeLocal(SAVED_KEY, next);

    if (walletAddress) {
      try {
        if (alreadySaved) {
          await apiRequest(`/api/learn/saved/${encodeURIComponent(video.videoId)}?walletAddress=${encodeURIComponent(walletAddress)}`, { method: 'DELETE' });
        } else {
          await apiRequest('/api/learn/saved', { method: 'POST', body: { walletAddress, ...video } });
        }
      } catch {
        // Local state already updated — backend sync can retry on next merge.
      }
    }
    return !alreadySaved;
  }, [saved, walletAddress]);

  const updateProgress = useCallback((entry) => {
    const next = [{ ...entry, updatedAt: new Date().toISOString() }, ...progress.filter((p) => p.videoId !== entry.videoId)];
    setProgress(next);
    writeLocal(PROGRESS_KEY, next);

    if (walletAddress) {
      apiRequest('/api/learn/progress', { method: 'POST', body: { walletAddress, ...entry } }).catch(() => {});
    }
  }, [progress, walletAddress]);

  return { ready, saved, progress, isVideoSaved, getVideoProgress, toggleSave, updateProgress };
}

export async function reportLearnVideo({ videoId, reason, detail, walletAddress }) {
  return apiRequest('/api/learn/report', { method: 'POST', body: { videoId, reason, detail, walletAddress } });
}

export async function logLearnEvent({ event, categoryId, videoId }) {
  try {
    await apiRequest('/api/learn/analytics', { method: 'POST', body: { event, categoryId, videoId } });
  } catch {
    // analytics failures are silently ignored by design
  }
}

export async function getLearnConfig() {
  return apiRequest('/api/learn/config');
}

export async function searchLearnVideos({ query, categoryId, pageToken }) {
  const params = new URLSearchParams({ q: query });
  if (categoryId) params.set('category', categoryId);
  if (pageToken) params.set('pageToken', pageToken);
  return apiRequest(`/api/learn/search?${params.toString()}`);
}

export async function getLearnVideo(videoId, relatedCategoryId) {
  const qs = relatedCategoryId ? `?related=${encodeURIComponent(relatedCategoryId)}` : '';
  return apiRequest(`/api/learn/video/${encodeURIComponent(videoId)}${qs}`);
}

export async function askLearnTutor({ walletAddress, videoContext, messages }) {
  return apiRequest('/api/ai/learn-chat', { method: 'POST', body: { walletAddress, videoContext, messages } });
}
