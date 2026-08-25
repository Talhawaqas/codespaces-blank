"use client";

// src/components/learn/LearnSearchResults.js — web port of
// LearnSearchResultsScreen.js. Uses a "Load more" button rather than
// scroll-triggered pagination — this app has no existing infinite-scroll
// pattern on web, and a button is simpler to get right than a scroll
// listener for the same pageToken-based pagination the mobile FlatList
// version uses.

import { useState, useEffect, useCallback } from 'react';
import { searchLearnVideos, logLearnEvent } from './useLearnLibrary';
import VideoCard from './VideoCard';

export default function LearnSearchResults({ query, categoryId, isVideoSaved, toggleSave, onOpenVideo }) {
  const [results, setResults] = useState([]);
  const [pageToken, setPageToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const runSearch = useCallback(async (token) => {
    try {
      const data = await searchLearnVideos({ query, categoryId, pageToken: token });
      setResults((prev) => (token ? [...prev, ...data.results] : data.results));
      setPageToken(data.nextPageToken || null);
      setError(null);
    } catch (err) {
      setError(err.message || 'Search failed.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [query, categoryId]);

  useEffect(() => {
    setLoading(true);
    setResults([]);
    setPageToken(null);
    runSearch(null);
    logLearnEvent({ event: 'search_performed', categoryId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, categoryId]);

  const loadMore = () => {
    if (!pageToken || loadingMore) return;
    setLoadingMore(true);
    runSearch(pageToken);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <p className="text-[#8a96ab] text-[10px] font-mono uppercase tracking-widest">Educational results for</p>
        <h2 className="text-white text-xl font-extrabold">“{query}”</h2>
      </div>

      {loading ? (
        <p className="text-[#8a96ab] text-xs font-mono">Searching…</p>
      ) : error ? (
        <p className="text-red-400 text-sm">{error}</p>
      ) : results.length === 0 ? (
        <p className="text-[#8a96ab] text-sm">No educational results found. Try a different search.</p>
      ) : (
        <>
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
          {pageToken && (
            <div className="text-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-5 py-2.5 rounded-lg text-xs font-bold text-[#00f2fe] border border-[#00f2fe]/30 hover:bg-[#00f2fe]/10 transition-all disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
