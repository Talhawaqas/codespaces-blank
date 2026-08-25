"use client";

// src/components/learn/LearnHome.js — web port of LearnHomeScreen.js.

import { useState, useEffect } from 'react';
import { getLearnConfig } from './useLearnLibrary';
import VideoCard from './VideoCard';

export default function LearnHome({ progress, onSearch, onOpenCategory, onOpenVideo, onOpenTutor }) {
  const [query, setQuery] = useState('');
  const [config, setConfig] = useState(null);
  const [loadingConfig, setLoadingConfig] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        setConfig(await getLearnConfig());
      } catch {
        setConfig({ categories: [], collections: [], paths: [] });
      } finally {
        setLoadingConfig(false);
      }
    })();
  }, []);

  const runSearch = (e) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed) onSearch(trimmed, null);
  };

  const continuing = progress.filter((p) => p.status === 'watching').slice(0, 6);

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div>
        <h2 className="text-2xl font-extrabold text-white">Inaya Learn</h2>
        <p className="text-[#94a3b8] text-sm mt-1">What do you want to learn today?</p>
      </div>

      <form onSubmit={runSearch} className="flex items-center gap-2 bg-[#090d16]/80 border border-white/5 focus-within:border-[#00f2fe]/40 rounded-xl px-4 py-3">
        <span className="text-[#8a96ab]">🔎</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search courses, topics and lessons"
          className="flex-1 bg-transparent outline-none text-white text-sm placeholder:text-[#8a96ab]"
        />
      </form>

      <button onClick={onOpenTutor} className="relative w-full text-left group">
        <div className="absolute -inset-[1px] rounded-2xl bg-gradient-to-r from-[#00f2fe] via-[#4facfe] to-[#c084fc] opacity-60 blur-[2px] group-hover:opacity-90 transition-opacity" />
        <div className="relative bg-[#0a0f1e] rounded-2xl px-5 py-4 flex items-center gap-4">
          <span className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#00f2fe] to-[#4facfe] flex items-center justify-center text-2xl shrink-0">🎓</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white text-base font-extrabold">Ask the Inaya Learn AI Tutor</span>
              <span className="text-[11px] font-bold tracking-wider text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/30 rounded-full px-2 py-0.5">
                AI-POWERED
              </span>
            </div>
            <p className="text-[#94a3b8] text-xs mt-0.5">Explain a concept, quiz yourself, or get help with anything you&apos;re learning</p>
          </div>
          <span className="text-[#00f2fe] text-sm font-bold shrink-0 hidden sm:block">Ask now →</span>
        </div>
      </button>

      {continuing.length > 0 && (
        <div>
          <h3 className="text-white font-bold text-sm mb-3">Continue Watching</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {continuing.map((p) => (
              <VideoCard
                key={p.videoId}
                title={p.title}
                channelTitle={p.channelTitle}
                thumbnailUrl={p.thumbnailUrl}
                progressPercent={p.durationSeconds ? (p.positionSeconds / p.durationSeconds) * 100 : 0}
                onClick={() => onOpenVideo(p.videoId, p.categoryId)}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-white font-bold text-sm mb-3">Recommended Categories</h3>
        {loadingConfig ? (
          <p className="text-[#8a96ab] text-xs font-mono">Loading…</p>
        ) : (
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {config.categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => onOpenCategory(cat.id)}
                className="bg-[#090d16]/80 border border-white/5 hover:border-[#00f2fe]/40 rounded-xl p-3 aspect-square flex flex-col items-center justify-center gap-1 transition-all"
              >
                <span className="text-xl">{cat.icon}</span>
                <span className="text-[12px] text-[#94a3b8] text-center leading-tight">{cat.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!loadingConfig && config.collections.length > 0 && (
        <div>
          <h3 className="text-white font-bold text-sm mb-3">Featured Learning Collections</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {config.collections.map((col) => (
              <button
                key={col.id}
                onClick={() => onOpenCategory(col.categoryId)}
                className="text-left bg-[#090d16]/80 border border-white/5 hover:border-[#00f2fe]/40 rounded-xl p-4 transition-all"
              >
                <p className="text-[#00f2fe] font-bold text-sm">{col.title}</p>
                <p className="text-[#94a3b8] text-xs mt-1 leading-relaxed">{col.description}</p>
                <p className="text-[#8a96ab] text-[12px] font-mono mt-3">{col.topics.map((t) => t.title).join(' · ')}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
