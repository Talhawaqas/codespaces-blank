"use client";

// src/components/learn/LearnVideo.js — web port of LearnVideoScreen.js.
// Uses the raw YT.Player instance from YoutubePlayer's onReady, polls
// getCurrentTime()/getDuration() while playing to sync progress — same
// approach and same 92% "completed" threshold as the mobile screen.

import { useState, useEffect, useRef, useCallback } from 'react';
import YoutubePlayer from './YoutubePlayer';
import VideoCard from './VideoCard';
import { getLearnVideo, reportLearnVideo, logLearnEvent, askLearnTutor } from './useLearnLibrary';

const PROGRESS_SYNC_INTERVAL_MS = 8000;
const COMPLETE_THRESHOLD = 0.92;

const REPORT_REASONS = [
  { id: 'not_educational', label: 'Not educational' },
  { id: 'unavailable', label: 'Unavailable / broken' },
  { id: 'inappropriate', label: 'Inappropriate' },
  { id: 'other', label: 'Other' },
];

export default function LearnVideo({ videoId, categoryId, walletAddress, isVideoSaved, toggleSave, getVideoProgress, updateProgress, onOpenVideo }) {
  const [video, setVideo] = useState(null);
  const [more, setMore] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  const [markedComplete, setMarkedComplete] = useState(false);

  const [tutorOpen, setTutorOpen] = useState(false);
  const [tutorMessages, setTutorMessages] = useState([]);
  const [tutorInput, setTutorInput] = useState('');
  const [tutorSending, setTutorSending] = useState(false);

  const playerInstanceRef = useRef(null);
  const hasSeekedRef = useRef(false);
  const syncTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMarkedComplete(false);
    hasSeekedRef.current = false;
    setTutorMessages([]);
    setTutorOpen(false);
    (async () => {
      try {
        const data = await getLearnVideo(videoId, categoryId);
        if (cancelled) return;
        setVideo(data.video);
        setMore(data.more || []);
        setMarkedComplete(getVideoProgress(videoId)?.status === 'completed');
        logLearnEvent({ event: 'video_started', videoId, categoryId });
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load this video.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  useEffect(() => () => { if (syncTimerRef.current) clearInterval(syncTimerRef.current); }, []);

  const syncProgress = useCallback((status) => {
    const player = playerInstanceRef.current;
    if (!player) return;
    try {
      const current = player.getCurrentTime();
      const duration = player.getDuration();
      if (!duration) return;
      const ratio = current / duration;
      const finalStatus = status || (ratio >= COMPLETE_THRESHOLD ? 'completed' : 'watching');
      if (finalStatus === 'completed' && !markedComplete) {
        setMarkedComplete(true);
        logLearnEvent({ event: 'video_completed', videoId, categoryId });
      }
      updateProgress({
        videoId,
        title: video?.title,
        thumbnailUrl: video?.thumbnailUrl,
        channelTitle: video?.channelTitle,
        categoryId,
        positionSeconds: Math.floor(current),
        durationSeconds: Math.floor(duration),
        status: finalStatus,
      });
    } catch {
      // Player not fully ready — safe to skip, next interval tick retries.
    }
  }, [videoId, categoryId, video, updateProgress, markedComplete]);

  const handleReady = useCallback((player) => {
    playerInstanceRef.current = player;
  }, []);

  const handleStateChange = useCallback((state) => {
    if (state === 'playing') {
      if (!hasSeekedRef.current) {
        hasSeekedRef.current = true;
        const resumeAt = getVideoProgress(videoId)?.positionSeconds;
        if (resumeAt > 5) playerInstanceRef.current?.seekTo(resumeAt, true);
      }
      if (!syncTimerRef.current) {
        syncTimerRef.current = setInterval(() => syncProgress(), PROGRESS_SYNC_INTERVAL_MS);
      }
    } else if (state === 'paused') {
      syncProgress();
    } else if (state === 'ended') {
      syncProgress('completed');
    }
  }, [videoId, getVideoProgress, syncProgress]);

  const handleToggleSave = () => {
    if (!video) return;
    const wasSaved = isVideoSaved(videoId);
    toggleSave({ videoId, title: video.title, thumbnailUrl: video.thumbnailUrl, channelTitle: video.channelTitle, categoryId });
    logLearnEvent({ event: wasSaved ? 'video_unsaved' : 'video_saved', videoId, categoryId });
  };

  const handleReport = async (reason) => {
    try {
      await reportLearnVideo({ videoId, reason, walletAddress });
      setReportSent(true);
      setReportOpen(false);
    } catch {
      setReportOpen(false);
    }
  };

  const handleSendTutorMessage = async () => {
    const text = tutorInput.trim();
    if (!text || tutorSending) return;
    const nextMessages = [...tutorMessages, { role: 'user', content: text }];
    setTutorMessages(nextMessages);
    setTutorInput('');
    setTutorSending(true);
    try {
      const data = await askLearnTutor({
        walletAddress,
        videoContext: video ? { title: video.title, channelTitle: video.channelTitle, categoryId, description: video.description } : null,
        messages: nextMessages,
      });
      setTutorMessages([...nextMessages, { role: 'assistant', content: data.reply || "Sorry, I couldn't come up with an answer for that." }]);
    } catch {
      setTutorMessages([...nextMessages, { role: 'assistant', content: 'The tutor is temporarily unavailable — please try again in a moment.' }]);
    } finally {
      setTutorSending(false);
    }
  };

  if (loading) return <div className="max-w-3xl mx-auto"><p className="text-[#64748b] text-xs font-mono">Loading…</p></div>;
  if (error || !video) return <div className="max-w-3xl mx-auto"><p className="text-red-400 text-sm">{error || 'This video is unavailable.'}</p></div>;

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <YoutubePlayer videoId={videoId} onReady={handleReady} onStateChange={handleStateChange} />

      <div>
        <h2 className="text-white text-lg font-bold leading-snug">{video.title}</h2>
        <p className="text-[#94a3b8] text-xs mt-1">{video.channelTitle}</p>
      </div>

      <div className="flex items-center gap-5 text-xs font-semibold">
        <button onClick={handleToggleSave} className={`flex items-center gap-1.5 ${isVideoSaved(videoId) ? 'text-[#00f2fe]' : 'text-[#94a3b8] hover:text-slate-300'}`}>
          <span>{isVideoSaved(videoId) ? '🔖' : '🏷️'}</span> Save
        </button>
        <button onClick={() => syncProgress('completed')} disabled={markedComplete} className={`flex items-center gap-1.5 ${markedComplete ? 'text-emerald-400' : 'text-[#94a3b8] hover:text-slate-300'}`}>
          <span>{markedComplete ? '✅' : '⭕'}</span> {markedComplete ? 'Completed' : 'Mark complete'}
        </button>
        <button onClick={() => setReportOpen((o) => !o)} disabled={reportSent} className="flex items-center gap-1.5 text-[#64748b] hover:text-slate-300">
          <span>🚩</span> {reportSent ? 'Reported' : 'Report'}
        </button>
      </div>

      {reportOpen && (
        <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-2 inline-flex flex-col">
          {REPORT_REASONS.map((r) => (
            <button key={r.id} onClick={() => handleReport(r.id)} className="text-left px-3 py-2 text-xs text-[#94a3b8] hover:text-white hover:bg-white/5 rounded-lg">
              {r.label}
            </button>
          ))}
        </div>
      )}

      {video.description && (
        <p className="text-[#94a3b8] text-xs leading-relaxed whitespace-pre-wrap line-clamp-6">{video.description}</p>
      )}

      <div className="bg-[#090d16]/80 border border-white/5 rounded-xl overflow-hidden">
        <button
          onClick={() => setTutorOpen((o) => !o)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <span className="flex items-center gap-2 text-white text-sm font-bold">
            <span>🎓</span> Ask AI Tutor
          </span>
          <span className="text-[#64748b] text-xs">{tutorOpen ? '▲' : '▼'}</span>
        </button>

        {tutorOpen && (
          <div className="px-4 pb-4 space-y-3">
            {tutorMessages.length === 0 && (
              <p className="text-[#64748b] text-xs">
                Ask me anything about this video, or any question you have while learning.
              </p>
            )}

            {tutorMessages.length > 0 && (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {tutorMessages.map((m, i) => (
                  <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                        m.role === 'user' ? 'bg-[#00f2fe]/10 text-[#e2e8f0]' : 'bg-white/5 text-[#94a3b8]'
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {tutorSending && <p className="text-[#64748b] text-xs">Thinking…</p>}
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                value={tutorInput}
                onChange={(e) => setTutorInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !tutorSending) handleSendTutorMessage(); }}
                placeholder="Ask a question about this video…"
                disabled={tutorSending}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder:text-[#64748b] focus:outline-none focus:border-[#00f2fe]/40 disabled:opacity-50"
              />
              <button
                onClick={handleSendTutorMessage}
                disabled={tutorSending || !tutorInput.trim()}
                className="bg-[#00f2fe]/10 text-[#00f2fe] text-xs font-semibold px-3 py-2 rounded-lg disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>

      {more.length > 0 && (
        <div>
          <h3 className="text-white font-bold text-sm mb-3">More like this</h3>
          <div className="grid grid-cols-1 gap-3">
            {more.map((item) => (
              <VideoCard
                key={item.videoId}
                title={item.title}
                channelTitle={item.channelTitle}
                thumbnailUrl={item.thumbnailUrl}
                onClick={() => onOpenVideo(item.videoId, categoryId)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
