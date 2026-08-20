"use client";

// src/components/learn/LearnMyLearning.js — web port of
// LearnMyLearningScreen.js. Simple segmented toggle, same as mobile.

import { useState } from 'react';
import VideoCard from './VideoCard';

const SECTIONS = [
  { id: 'watching', label: 'Continue Watching' },
  { id: 'completed', label: 'Completed' },
  { id: 'saved', label: 'Saved' },
];

export default function LearnMyLearning({ saved, progress, isVideoSaved, toggleSave, onOpenVideo }) {
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
        <p className="text-[#64748b] text-sm">
          {section === 'watching' && 'Nothing in progress yet — start a video from Learn Home.'}
          {section === 'completed' && "You haven't completed any videos yet."}
          {section === 'saved' && "You haven't saved any videos yet."}
        </p>
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
