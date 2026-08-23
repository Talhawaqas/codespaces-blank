"use client";

// src/components/learn/LearnSection.js
//
// Entry point for the "Learn" tab in the main dApp (src/app/page.js),
// mirroring how ReferralSection.js is wired in as a tab-content component.
// Owns simple internal view-state (home/search/video/myLearning/category)
// rather than being a real Next.js route — consistent with every other
// wallet-linked feature in this app (Faucet, Staking, Referrals, Watcher
// Pioneer), which are all tabs inside the one SPA, not separate pages.
// walletAddress is passed down from page.js's existing connected-wallet
// state — no new wallet plumbing needed here.

import { useState, useCallback } from 'react';
import { useLearnLibrary } from './useLearnLibrary';
import LearnHome from './LearnHome';
import LearnSearchResults from './LearnSearchResults';
import LearnVideo from './LearnVideo';
import LearnMyLearning from './LearnMyLearning';
import LearnCategory from './LearnCategory';
import LearnTutorWidget from './LearnTutorWidget';

export default function LearnSection({ walletAddress }) {
  const [view, setView] = useState({ name: 'home' });
  const [currentVideo, setCurrentVideo] = useState(null);
  const { saved, progress, isVideoSaved, getVideoProgress, toggleSave, updateProgress } = useLearnLibrary(walletAddress);

  const openHome = useCallback(() => { setView({ name: 'home' }); setCurrentVideo(null); }, []);
  const openSearch = useCallback((query, categoryId) => { setView({ name: 'search', query, categoryId }); setCurrentVideo(null); }, []);
  const openVideo = useCallback((videoId, categoryId) => setView({ name: 'video', videoId, categoryId }), []);
  const openCategory = useCallback((categoryId) => { setView({ name: 'category', categoryId }); setCurrentVideo(null); }, []);
  const openMyLearning = useCallback(() => { setView({ name: 'myLearning' }); setCurrentVideo(null); }, []);

  return (
    <div>
      <div className="max-w-5xl mx-auto flex items-center justify-between mb-6">
        <button onClick={openHome} className="text-xs text-[#64748b] hover:text-slate-300 font-mono">← Inaya Learn</button>
        <button onClick={openMyLearning} className="text-xs font-bold text-[#00f2fe] hover:text-white flex items-center gap-1.5">
          📚 My Learning
        </button>
      </div>

      {view.name === 'home' && (
        <LearnHome progress={progress} onSearch={openSearch} onOpenCategory={openCategory} onOpenVideo={openVideo} />
      )}
      {view.name === 'search' && (
        <LearnSearchResults
          query={view.query}
          categoryId={view.categoryId}
          isVideoSaved={isVideoSaved}
          toggleSave={toggleSave}
          onOpenVideo={openVideo}
        />
      )}
      {view.name === 'video' && (
        <LearnVideo
          videoId={view.videoId}
          categoryId={view.categoryId}
          walletAddress={walletAddress}
          isVideoSaved={isVideoSaved}
          toggleSave={toggleSave}
          getVideoProgress={getVideoProgress}
          updateProgress={updateProgress}
          onOpenVideo={openVideo}
          onVideoLoaded={setCurrentVideo}
        />
      )}
      {view.name === 'myLearning' && (
        <LearnMyLearning saved={saved} progress={progress} isVideoSaved={isVideoSaved} toggleSave={toggleSave} onOpenVideo={openVideo} />
      )}
      {view.name === 'category' && (
        <LearnCategory
          categoryId={view.categoryId}
          isVideoSaved={isVideoSaved}
          toggleSave={toggleSave}
          onOpenVideo={openVideo}
          onSearch={openSearch}
        />
      )}

      <LearnTutorWidget walletAddress={walletAddress} videoContext={currentVideo} />
    </div>
  );
}
