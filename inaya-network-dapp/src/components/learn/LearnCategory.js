"use client";

// src/components/learn/LearnCategory.js — web port of LearnCategoryScreen.js.

import { useState, useEffect } from 'react';
import { getLearnConfig, searchLearnVideos, logLearnEvent } from './useLearnLibrary';
import VideoCard from './VideoCard';

export default function LearnCategory({ categoryId, isVideoSaved, toggleSave, onOpenVideo, onSearch }) {
  const [category, setCategory] = useState(null);
  const [collections, setCollections] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const config = await getLearnConfig();
        const cat = config.categories.find((c) => c.id === categoryId);
        const cols = config.collections.filter((c) => c.categoryId === categoryId);
        if (cancelled) return;
        setCategory(cat || null);
        setCollections(cols);

        const searchData = await searchLearnVideos({ query: cat?.name || categoryId, categoryId });
        if (!cancelled) setResults(searchData.results);

        logLearnEvent({ event: 'collection_opened', categoryId });
      } catch {
        // Best-effort — an empty category page is a reasonable fallback.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [categoryId]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <span className="text-3xl">{category?.icon}</span>
        <h2 className="text-white text-2xl font-extrabold mt-1">{category?.name || 'Category'}</h2>
      </div>

      {collections.map((col) => (
        <div key={col.id} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
          <p className="text-[#00f2fe] font-bold text-sm">{col.title}</p>
          <p className="text-[#94a3b8] text-xs mt-1 mb-3">{col.description}</p>
          <div className="flex flex-wrap gap-2">
            {col.topics.map((topic) => (
              <button
                key={topic.id}
                onClick={() => onSearch(topic.searchQuery, categoryId)}
                className="px-3 py-1.5 rounded-full border border-white/10 text-[#94a3b8] hover:border-[#00f2fe]/40 hover:text-white text-[11px] font-semibold transition-all"
              >
                {topic.title}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div>
        <h3 className="text-white font-bold text-sm mb-3">Recommended Videos</h3>
        {loading ? (
          <p className="text-[#8a96ab] text-xs font-mono">Loading…</p>
        ) : results.length === 0 ? (
          <p className="text-[#8a96ab] text-sm">No educational results found for this category yet.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {results.map((item) => (
              <VideoCard
                key={item.videoId}
                title={item.title}
                channelTitle={item.channelTitle}
                thumbnailUrl={item.thumbnailUrl}
                saved={isVideoSaved(item.videoId)}
                onToggleSave={() => toggleSave({ videoId: item.videoId, title: item.title, thumbnailUrl: item.thumbnailUrl, channelTitle: item.channelTitle, categoryId })}
                onClick={() => onOpenVideo(item.videoId, categoryId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
