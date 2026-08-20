// src/lib/learnConfig.js
//
// Single source of truth for Inaya Learn's categories, curated collections,
// and Inaya-relevant learning paths — mirrors the orgPlans.js/saasRoadmap.js
// convention of one canonical content file, served to the mobile app via
// GET /api/learn/config. Editing this file needs a backend deploy, not a
// new mobile app build — that's what "configurable without a new mobile
// application build" (spec §2, §8) actually requires; a Mongo-backed
// admin-CRUD version (edits without even a backend deploy) is a reasonable
// Phase 2, not built here.
//
// `searchKeywords` on a category/topic are appended to the user's raw
// query before it's sent to YouTube's search.list, as one of several
// educational-relevance signals (alongside videoCategoryId=27) — see
// src/lib/youtube.js. This does not guarantee every result is educational
// (spec §4 explicitly disclaims that); it's a relevance boost, not a filter.

export const LEARN_CATEGORIES = [
  { id: "programming", name: "Programming", icon: "💻", searchKeywords: "programming tutorial coding" },
  { id: "ai", name: "Artificial Intelligence", icon: "🤖", searchKeywords: "artificial intelligence machine learning tutorial" },
  { id: "web3", name: "Web3 & Blockchain", icon: "⛓️", searchKeywords: "web3 blockchain tutorial" },
  { id: "cybersecurity", name: "Cybersecurity", icon: "🛡️", searchKeywords: "cybersecurity tutorial fundamentals" },
  { id: "business", name: "Business", icon: "💼", searchKeywords: "business tutorial fundamentals" },
  { id: "finance", name: "Finance", icon: "💰", searchKeywords: "finance tutorial fundamentals" },
  { id: "design", name: "Design", icon: "🎨", searchKeywords: "design tutorial fundamentals" },
  { id: "mathematics", name: "Mathematics", icon: "📐", searchKeywords: "mathematics tutorial lesson" },
  { id: "science", name: "Science", icon: "🔬", searchKeywords: "science tutorial lesson" },
  { id: "education", name: "Education / Study", icon: "📚", searchKeywords: "study lesson course" },
  { id: "entrepreneurship", name: "Entrepreneurship", icon: "🚀", searchKeywords: "entrepreneurship startup tutorial" },
];

export const LEARN_COLLECTIONS = [
  {
    id: "learn-web3",
    title: "Learn Web3",
    description: "Blockchain fundamentals through smart contracts and decentralized infrastructure.",
    categoryId: "web3",
    topics: [
      { id: "blockchain-fundamentals", title: "Blockchain Fundamentals", searchQuery: "blockchain fundamentals explained" },
      { id: "ethereum-basics", title: "Ethereum Basics", searchQuery: "ethereum basics for beginners" },
      { id: "solidity", title: "Solidity", searchQuery: "solidity for beginners" },
      { id: "smart-contracts", title: "Smart Contracts", searchQuery: "smart contracts explained tutorial" },
      { id: "defi", title: "DeFi", searchQuery: "defi explained for beginners" },
      { id: "depin", title: "DePIN", searchQuery: "DePIN decentralized physical infrastructure explained" },
    ],
  },
  {
    id: "learn-ai",
    title: "Learn AI",
    description: "From AI fundamentals to building with modern language models.",
    categoryId: "ai",
    topics: [
      { id: "ai-fundamentals", title: "AI Fundamentals", searchQuery: "artificial intelligence fundamentals explained" },
      { id: "machine-learning", title: "Machine Learning", searchQuery: "machine learning basics tutorial" },
      { id: "llms", title: "LLMs", searchQuery: "large language models explained" },
      { id: "prompt-engineering", title: "Prompt Engineering", searchQuery: "prompt engineering tutorial" },
      { id: "ai-development", title: "AI Development", searchQuery: "AI application development tutorial" },
    ],
  },
  {
    id: "learn-programming",
    title: "Learn Programming",
    description: "Core languages and frameworks for modern software development.",
    categoryId: "programming",
    topics: [
      { id: "python", title: "Python", searchQuery: "python for beginners" },
      { id: "javascript", title: "JavaScript", searchQuery: "javascript for beginners" },
      { id: "react", title: "React", searchQuery: "react tutorial for beginners" },
      { id: "nodejs", title: "Node.js", searchQuery: "node.js tutorial for beginners" },
      { id: "rust", title: "Rust", searchQuery: "rust programming for beginners" },
      { id: "solidity-programming", title: "Solidity", searchQuery: "solidity for beginners" },
    ],
  },
];

// Informational only — must not imply that watching these videos
// automatically qualifies a user for any Inaya reward or program
// (spec §10). Rendered with an explicit disclaimer in the mobile UI.
export const LEARN_PATHS = [
  {
    id: "become-web3-developer",
    title: "Become a Web3 Developer",
    steps: [
      { title: "Blockchain basics", searchQuery: "blockchain basics explained" },
      { title: "Solidity", searchQuery: "solidity for beginners" },
      { title: "Smart contracts", searchQuery: "smart contracts explained tutorial" },
      { title: "Wallet integration", searchQuery: "web3 wallet integration tutorial" },
      { title: "DePIN", searchQuery: "DePIN decentralized physical infrastructure explained" },
      { title: "Node infrastructure", searchQuery: "blockchain node infrastructure explained" },
    ],
  },
  {
    id: "become-inaya-node-operator",
    title: "Become an Inaya Node Operator",
    steps: [
      { title: "Linux basics", searchQuery: "linux basics for beginners" },
      { title: "Networking", searchQuery: "computer networking fundamentals" },
      { title: "Storage fundamentals", searchQuery: "data storage fundamentals explained" },
      { title: "Node operation", searchQuery: "blockchain node operation tutorial" },
      { title: "Decentralized infrastructure", searchQuery: "decentralized infrastructure explained" },
    ],
  },
];

export function getLearnConfig() {
  return {
    categories: LEARN_CATEGORIES,
    collections: LEARN_COLLECTIONS,
    paths: LEARN_PATHS,
  };
}
