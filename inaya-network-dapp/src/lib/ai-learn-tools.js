// src/lib/ai-learn-tools.js
//
// Tool implementations for the Inaya Learn AI Tutor (POST /api/ai/learn-chat).
//
// Structurally the same Gemini function-calling pattern as
// ai-business-tools.js/ai-security-tools.js, but a different guardrail
// philosophy on purpose: the Security Assistant must NEVER go beyond
// verified data (there's no such thing as "explain what phishing might be
// in general" for a threat feed). A tutor's entire job is the opposite —
// explain concepts, answer "why", teach — using the model's own general
// knowledge is exactly what's wanted here. Tools exist only to ground the
// tutor in the user's OWN Inaya Learn data (their saved videos, their
// progress, the video they're currently watching) so it never has to
// guess about state that's actually queryable, not to gate what subject
// matter it's allowed to discuss.

import { Type } from "@google/genai";
import { getLearnCollections, normalizeWallet } from "./learn.js";
import { retrieveContext, formatAttribution } from "./rag/retrieve.js";
import { ensureVideoTranscriptIngested } from "./rag/sources/learnSources.js";

/** Computed once per chat request. videoContext is client-supplied (the video already loaded on
 *  the page/screen the user is asking about) — trusted the same way every other Learn route
 *  trusts a client-provided videoId, not re-verified against YouTube on every chat turn.
 *
 *  If a videoId is present, this ALSO attempts (best-effort, bounded) to lazily ingest that
 *  video's real transcript — see rag/sources/learnSources.js's ensureVideoTranscriptIngested()
 *  and youtubeTranscript.js's header comment for the honest caveats on how that works and why
 *  it can fail. transcriptAvailable tells search_learn_knowledge below whether it's safe to
 *  prioritize this specific video's chunks. */
export async function buildLearnContext({ walletAddress, videoContext }) {
  const videoId = videoContext?.videoId || null;
  const transcriptAvailable = videoId ? await ensureVideoTranscriptIngested(videoId, videoContext?.title) : false;
  return { walletAddress: normalizeWallet(walletAddress || ""), videoContext: videoContext || null, videoId, transcriptAvailable };
}

async function getSavedVideos(_args, ctx) {
  if (!ctx.walletAddress) return { known: false, message: "No wallet connected — saved videos aren't available." };
  const { saved } = await getLearnCollections();
  const items = await saved.find({ walletAddress: ctx.walletAddress }).sort({ savedAt: -1 }).limit(50).toArray();
  return { count: items.length, videos: items.map((v) => ({ title: v.title, channelTitle: v.channelTitle, categoryId: v.categoryId })) };
}

async function getLearningProgress(args, ctx) {
  if (!ctx.walletAddress) return { known: false, message: "No wallet connected — learning progress isn't available." };
  const { progress } = await getLearnCollections();
  const filter = { walletAddress: ctx.walletAddress };
  if (args?.status) filter.status = args.status;
  const items = await progress.find(filter).sort({ updatedAt: -1 }).limit(50).toArray();
  return {
    count: items.length,
    items: items.map((p) => ({
      title: p.title,
      categoryId: p.categoryId,
      status: p.status,
      percentComplete: p.durationSeconds ? Math.round((p.positionSeconds / p.durationSeconds) * 100) : null,
    })),
  };
}

function getCurrentVideo(_args, ctx) {
  if (!ctx.videoContext) return { known: false, message: "No video is currently open." };
  return { known: true, ...ctx.videoContext };
}

/** Priority order per the SOW: (1-2) the current video's own transcript
 *  first — sourceId-restricted so a chunk from a DIFFERENT video never
 *  outranks the one actually on screen; only if that comes up empty
 *  (no transcript available, or the transcript doesn't cover this
 *  question) does it fall through to (3-5) wider Learn/Docs content. Two
 *  retrieval calls rather than one so "this video" results are never
 *  diluted by wider-corpus noise when they exist. */
async function searchLearnKnowledge(args, ctx) {
  const query = args?.query;
  if (!query) return { error: "query is required." };

  if (ctx.videoId && ctx.transcriptAvailable) {
    const videoResult = await retrieveContext({ query, domain: "learn", sourceId: `youtube:${ctx.videoId}` });
    if (videoResult.hasResults) {
      return {
        found: true, scope: "current_video",
        excerpts: videoResult.chunks.map((c) => ({ title: c.title, text: c.text })),
        attribution: formatAttribution(videoResult.chunks).trim(),
      };
    }
  }

  const wideResult = await retrieveContext({ query, domain: "learn" });
  const docsResult = await retrieveContext({ query, domain: "docs" });
  const combined = [...wideResult.chunks, ...docsResult.chunks];
  if (combined.length === 0) {
    return { found: false, message: "No indexed Inaya Learn content matches this — answer from your own general knowledge as usual." };
  }
  return {
    found: true, scope: "wider_learn",
    excerpts: combined.map((c) => ({ title: c.title, section: c.section, text: c.text })),
    attribution: formatAttribution(combined).trim(),
  };
}

// ============================================================
// Gemini function-calling declarations + dispatcher
// ============================================================
export const LEARN_TOOL_DECLARATIONS = [
  {
    name: "search_learn_knowledge",
    description: "Search Inaya's indexed Learn/Docs knowledge — prioritizes the CURRENT video's own transcript when one is open, falling back to wider Inaya Learn content and Inaya's own product documentation. Use this before answering anything specific to the current video, or any Inaya-specific question (e.g. \"what is Inaya Learn\", \"how does staking work\") — you are NOT restricted to only what this tool returns for general educational teaching, only for Inaya-specific facts.",
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING, description: "The question to search for." } },
      required: ["query"],
    },
  },
  {
    name: "get_current_video",
    description: "Get details (title, channel, category, description) of the video the user is currently watching, if any.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_saved_videos",
    description: "Get the user's saved/bookmarked videos in Inaya Learn.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "get_learning_progress",
    description: "Get the user's watch progress across videos — what they're currently watching or have completed.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.STRING, enum: ["watching", "completed"], description: "Filter to only this status." },
      },
    },
  },
];

const TOOL_IMPLEMENTATIONS = {
  search_learn_knowledge: searchLearnKnowledge,
  get_current_video: getCurrentVideo,
  get_saved_videos: getSavedVideos,
  get_learning_progress: getLearningProgress,
};

export async function runLearnTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function learnSystemInstruction({ videoContext, transcriptAvailable }) {
  const videoLine = videoContext
    ? `The user is currently watching: "${videoContext.title}" by ${videoContext.channelTitle || "unknown channel"} (category: ${videoContext.categoryId || "general"}).` +
      (transcriptAvailable
        ? " A real transcript of this specific video is indexed and searchable via search_learn_knowledge."
        : " No transcript is available for this video (not every video has captions, or it couldn't be fetched) — you don't have its actual spoken content indexed.")
    : "The user isn't currently watching a specific video.";

  return `You are the Inaya Learn AI Tutor, embedded in Inaya Network's free educational video platform. ${videoLine}

Your job is to teach: explain concepts clearly, answer follow-up questions, define unfamiliar terms, and help the user actually understand the material — using your own general knowledge, the same way any good tutor would. For general teaching (explaining a concept, answering "why does this work", quizzing the user), you are not limited to only what a tool returns; that's specifically for Security's assistant, not yours.

Two important exceptions where you MUST ground in search_learn_knowledge rather than general knowledge, and say so explicitly when you do:
1. Anything about what THIS SPECIFIC video actually says/covers ("what did they say about X", "summarize this video") — only claim something is "in this video" if search_learn_knowledge's excerpts (scope: current_video) actually support it. If no transcript is available or the transcript doesn't cover the question, say so plainly rather than guessing what the video probably said.
2. Anything specific to Inaya itself (Inaya Learn features, other Inaya products, Inaya's own facts/figures) — look these up rather than guessing, same reasoning the Docs assistant follows.

Use get_current_video, get_saved_videos, and get_learning_progress only to ground answers about the user's OWN Inaya Learn activity (e.g. "what have I saved", "how far am I into this video") — never guess at that, look it up.

Keep answers concise and encouraging, written for someone actively learning, not a textbook. If a question is genuinely outside anything educational Inaya Learn would cover, gently redirect rather than refusing outright — you're a tutor, not a gatekeeper.`;
}
