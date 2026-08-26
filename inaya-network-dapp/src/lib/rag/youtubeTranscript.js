// src/lib/rag/youtubeTranscript.js
//
// Fetches a public YouTube video's caption track WITHOUT the official
// Data API — the official `captions.download` endpoint only works via
// OAuth as the video's own channel owner, which is useless for arbitrary
// third-party videos users watch in Inaya Learn. This uses the same
// public, undocumented mechanism the YouTube player itself uses (and the
// same one every `youtube-transcript`-style library relies on): scrape
// the caption-track URL out of the watch page's embedded player response,
// then fetch that track's own XML.
//
// HONEST CAVEATS (flagged in the SOW plan, repeating here so it's visible
// at the point of use, not just in a planning doc): this is unofficial
// surface that could break if YouTube changes its page structure, and
// downloading third-party caption text for storage/embedding sits in a
// ToS gray area beyond normal playback. Every failure mode below —
// missing captions, blocked/private video, YouTube changing its HTML,
// a network error — returns null. This function must NEVER throw; callers
// (learnSources.js's ensureVideoTranscriptIngested) depend on that to
// degrade gracefully to the tutor's existing general-knowledge behavior.

const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractCaptionTracks(watchPageHtml) {
  const match = /"captionTracks":(\[.*?\])(?=,"(?:audioTracks|translationLanguages)")/.exec(watchPageHtml);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

function pickBestTrack(tracks) {
  if (!tracks.length) return null;
  const manualEnglish = tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr");
  if (manualEnglish) return manualEnglish;
  const autoEnglish = tracks.find((t) => t.languageCode?.startsWith("en"));
  if (autoEnglish) return autoEnglish;
  return tracks[0];
}

function parseCaptionXml(xml) {
  const segments = [];
  const regex = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const startSec = parseFloat(match[1]);
    const text = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "")).trim();
    if (text) segments.push({ startSec, text });
  }
  return segments;
}

/** Returns { segments: [{startSec, text}], fullText } or null on any
 *  failure (no captions, private/restricted video, network error, or
 *  YouTube's page structure having changed since this was written). */
export async function fetchYouTubeTranscript(videoId) {
  if (!videoId || typeof videoId !== "string") return null;

  try {
    const watchRes = await fetchWithTimeout(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; InayaLearnBot/1.0)" },
    });
    if (!watchRes.ok) return null;
    const html = await watchRes.text();

    const tracks = extractCaptionTracks(html);
    const track = pickBestTrack(tracks);
    if (!track?.baseUrl) return null;

    const captionRes = await fetchWithTimeout(track.baseUrl);
    if (!captionRes.ok) return null;
    const xml = await captionRes.text();

    const segments = parseCaptionXml(xml);
    if (segments.length === 0) return null;

    return { segments, fullText: segments.map((s) => s.text).join(" ") };
  } catch (err) {
    console.error(`rag/youtubeTranscript: fetch failed for video ${videoId}:`, err.message);
    return null;
  }
}
