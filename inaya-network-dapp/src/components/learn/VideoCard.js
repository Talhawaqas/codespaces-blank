"use client";

// src/components/learn/VideoCard.js
//
// Web port of inaya-mobile's VideoCard — same layout/purpose, styled with
// this app's existing Tailwind conventions instead of RN StyleSheet.

function formatDuration(totalSeconds) {
  if (totalSeconds == null) return null;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function VideoCard({ title, channelTitle, thumbnailUrl, durationSeconds, progressPercent, saved, onClick, onToggleSave }) {
  const duration = formatDuration(durationSeconds);

  return (
    <div
      className="group bg-[#090d16]/80 border border-white/5 hover:border-[#00f2fe]/40 rounded-xl p-3 flex items-center gap-3 transition-all cursor-pointer"
      onClick={onClick}
    >
      <div className="relative w-28 h-16 shrink-0 rounded-lg overflow-hidden bg-black/40">
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[#8a96ab] text-lg">🎓</div>
        )}
        {duration && (
          <span className="absolute right-1 bottom-1 bg-black/75 text-white text-[11px] font-mono px-1 rounded">{duration}</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-white text-xs font-semibold leading-snug line-clamp-2 group-hover:text-[#00f2fe] transition-colors">{title}</p>
        {channelTitle && <p className="text-[#94a3b8] text-[13px] mt-0.5 truncate">{channelTitle}</p>}
        {typeof progressPercent === 'number' && (
          <div className="mt-1.5">
            <div className="h-[3px] rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-[#00f2fe]" style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }} />
            </div>
            <span className="text-[11px] text-[#8a96ab] font-mono">{Math.round(progressPercent)}% complete</span>
          </div>
        )}
      </div>

      {onToggleSave && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSave(); }}
          className={`text-lg leading-none shrink-0 ${saved ? 'text-[#00f2fe]' : 'text-[#8a96ab] hover:text-slate-300'}`}
          title={saved ? 'Remove from saved' : 'Save'}
        >
          {saved ? '🔖' : '🏷️'}
        </button>
      )}
    </div>
  );
}
