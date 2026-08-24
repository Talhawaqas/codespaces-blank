"use client";

// src/components/learn/LearnMyLearning.js — web port of
// LearnMyLearningScreen.js. Simple segmented toggle, same as mobile.

import { useState } from 'react';
import VideoCard from './VideoCard';
import EmptyState from '../EmptyState';

const SECTIONS = [
  { id: 'watching', label: 'Continue Watching' },
  { id: 'completed', label: 'Completed' },
  { id: 'saved', label: 'Saved' },
];

const EMPTY_COPY = {
  watching: { icon: '▶️', title: 'Nothing in progress', description: 'Start a video from Learn Home and it shows up here so you can pick up where you left off.' },
  completed: { icon: '🎓', title: "You haven't finished a video yet", description: 'Completed videos land here once you watch them through — a good way to track real progress.' },
  saved: { icon: '🔖', title: "Nothing saved yet", description: 'Save any video from Learn Home to build a reading list for later.' },
};

export default function LearnMyLearning({ saved, progress, isVideoSaved, toggleSave, onOpenVideo, onGoHome }) {
  const [section, setSection] = useState('watching');

  let items = [];
  if (section === 'watching') items = progress.filter((p) => p.status === 'watching');
  else if (section === 'completed') items = progress.filter((p) => p.status === 'completed');
  else items = saved;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <h2 className="text-2xl font-extrabold text-white">My Learning</h2>

      <div className="flex gap-2">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`flex-1 py-2.5 rounded-lg text-[11px] font-bold border transition-all ${
              section === s.id ? 'text-[#00f2fe] border-[#00f2fe]/40 bg-[#00f2fe]/10' : 'text-[#64748b] border-white/10 hover:text-slate-300'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={EMPTY_COPY[section].icon}
          title={EMPTY_COPY[section].title}
          description={EMPTY_COPY[section].description}
          ctaLabel={onGoHome ? 'Browse Learn Home' : undefined}
          onCta={onGoHome}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map((item) => (
            <VideoCard
              key={item.videoId}
              title={item.title}
              channelTitle={item.channelTitle}
              thumbnailUrl={item.thumbnailUrl}
              progressPercent={item.durationSeconds ? (item.positionSeconds / item.durationSeconds) * 100 : undefined}
              saved={section === 'saved' ? true : isVideoSaved(item.videoId)}
              onToggleSave={() => toggleSave(item)}
              onClick={() => onOpenVideo(item.videoId, item.categoryId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
