"use client";

// src/components/learn/YoutubePlayer.js
//
// Thin wrapper around the official YouTube IFrame Player API
// (youtube.com/iframe_api) — the standard, ToS-compliant way to embed
// playback with real position/duration access on web (no separate library
// needed here, unlike the mobile app which needs react-native-youtube-
// iframe to bridge into a WebView). Loads the API script once per page
// (guards against double-injection if multiple players mount) and exposes
// the raw player instance via onReady so the caller owns all progress-sync
// logic, same responsibility split as the mobile screen.

import { useEffect, useRef, useId } from 'react';

let apiLoadPromise = null;

function loadYouTubeIframeApi() {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (apiLoadPromise) return apiLoadPromise;

  apiLoadPromise = new Promise((resolve) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve();
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.body.appendChild(tag);
  });
  return apiLoadPromise;
}

export default function YoutubePlayer({ videoId, onReady, onStateChange }) {
  const containerId = `yt-player-${useId().replace(/[:]/g, '')}`;
  const playerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    loadYouTubeIframeApi().then(() => {
      if (cancelled) return;
      playerRef.current = new window.YT.Player(containerId, {
        videoId,
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          onReady: () => onReady?.(playerRef.current),
          onStateChange: (event) => {
            const stateNames = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
            onStateChange?.(stateNames[event.data] || 'unknown');
          },
        },
      });
    });

    return () => {
      cancelled = true;
      playerRef.current?.destroy?.();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  return <div id={containerId} className="w-full aspect-video rounded-xl overflow-hidden bg-black" />;
}
