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

/** Computed once per chat request. videoContext is client-supplied (the video already loaded on
 *  the page/screen the user is asking about) — trusted the same way every other Learn route
 *  trusts a client-provided videoId, not re-verified against YouTube on every chat turn. */
export async function buildLearnContext({ walletAddress, videoContext }) {
  return { walletAddress: normalizeWallet(walletAddress || ""), videoContext: videoContext || null };
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

// ============================================================
// Gemini function-calling declarations + dispatcher
// ============================================================
export const LEARN_TOOL_DECLARATIONS = [
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
  get_current_video: getCurrentVideo,
  get_saved_videos: getSavedVideos,
  get_learning_progress: getLearningProgress,
};

export async function runLearnTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function learnSystemInstruction({ videoContext }) {
  const videoLine = videoContext
    ? `The user is currently watching: "${videoContext.title}" by ${videoContext.channelTitle || "unknown channel"} (category: ${videoContext.categoryId || "general"}).`
    : "The user isn't currently watching a specific video.";

  return `You are the Inaya Learn AI Tutor, embedded in Inaya Network's free educational video platform. ${videoLine}

Your job is to teach: explain concepts clearly, answer follow-up questions, define unfamiliar terms, and help the user actually understand the material — using your own general knowledge, the same way any good tutor would. You are not limited to only what a tool returns; that's specifically for Security's assistant, not yours.

Use get_current_video, get_saved_videos, and get_learning_progress only to ground answers about the user's OWN Inaya Learn activity (e.g. "what have I saved", "how far am I into this video") — never guess at that, look it up. For everything else (explaining a concept, answering "why does this work", quizzing the user), just teach directly.

Keep answers concise and encouraging, written for someone actively learning, not a textbook. If a question is genuinely outside anything educational Inaya Learn would cover, gently redirect rather than refusing outright — you're a tutor, not a gatekeeper.`;
}
