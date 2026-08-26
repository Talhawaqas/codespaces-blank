# Unified RAG Infrastructure

**Built:** August 26, 2026. One shared retrieval-augmented-generation layer powering all three of Inaya's AI assistants — Docs, Security, and Learn — replacing "whatever the model already knows about Inaya" with real, indexed, attributable knowledge.

## Where it lives

- **Core pipeline:** `src/lib/rag/` — `chunking.js`, `embeddings.js`, `vectorStore.js`, `retrieve.js`, `ingest.js`, `sanitize.js`, `queryCache.js`, `metrics.js`, `collections.js`, `youtubeTranscript.js`
- **Source adapters:** `src/lib/rag/sources/{docsSources,securitySources,learnSources}.js`
- **Assistant integration:** `src/app/api/ai/chat/route.js` (Docs), `src/lib/ai-security-tools.js` + `security-chat/route.js` (Security), `src/lib/ai-learn-tools.js` + `learn-chat/route.js` (Learn)
- **Admin:** `/admin/rag` (`src/app/admin/rag/page.js`), `src/app/api/admin/rag/{reingest,stats}/route.js`
- **Freshness:** `src/app/api/cron/rag-reingest/route.js`, nightly via `vercel.json`
- **Tests:** `test/rag-{ingestion,retrieval,security,attribution,learn-transcript}.test.mjs`

## Architecture

```
Knowledge Sources (curated JS/MD content, security policy, YouTube transcripts)
  → Ingestion adapters (per source type)
  → Chunking (heading/paragraph/structured-section splitters — no NLP library needed, content is already structured)
  → Embeddings (Gemini gemini-embedding-001, 768 dims, content-hash cached)
  → Vector store (MongoDB Atlas: rag_chunks + a Vector Search index + an Atlas Search text index)
  → Hybrid retrieval (vector + keyword, merged via Reciprocal Rank Fusion, domain-filtered)
  → retrieveContext() — the one function all three assistants call
  → Per-assistant system instruction assembly
```

**Zero new paid services.** MongoDB Atlas (already this project's database) natively supports Vector Search + Atlas Search; both indexes are created programmatically (`vectorStore.js`'s `ensureIndexes()`, idempotent) rather than requiring a manual Atlas dashboard step. Embeddings use Gemini's `embedContent` API — `@google/genai` is already the sole AI provider in this codebase, so no new API key or vendor account was needed.

The vector store sits behind a small interface (`upsertChunks`/`hybridSearch`/`deleteBySource`/`ensureIndexes`) with one concrete Atlas-backed implementation — the "keep the vector database replaceable" requirement is satisfied by that boundary, not by building a second, unused backend.

## Permission model — by construction, not by filter

Nothing private is ever ingested. `security_threats`/`security_reputation_cache`/`security_events`/`learn_progress`/`learn_saved` stay exactly where they already were: live, per-request tool-calls scoped by `identityId`/`walletAddress` in `ai-security-tools.js`/`ai-learn-tools.js`, never embedded into the shared `rag_chunks` collection. Only curated public knowledge (docs content, static security policy/explainer text, Learn config, public video transcripts) ever becomes a retrievable chunk. `test/rag-security.test.mjs` enforces this structurally — it statically scans every source-adapter file's code (comments excluded) for any reference to a private collection name and fails the build if one appears.

## Per-assistant behavior

- **Docs** (`/api/ai/chat`): the old static `INAYA_KNOWLEDGE_BASE` prompt injection is gone — every reply is now grounded in `retrieveContext({domain:'docs'})`'s real retrieved chunks. If nothing sufficiently relevant is found, the assistant says so plainly rather than falling back to the model's own (unverifiable) knowledge about Inaya. Indexed sources: the product knowledge-base digest, the Business Workspace guide, the FAQ page, and all 15 structured fundraising-docs content files (whitepaper, FAQs, SDK guide, business models, etc.).
- **Security** (`/api/ai/security-chat`): gained a new `search_security_documentation` tool for STATIC "how does X work" questions, kept clearly separate from the three existing live-data tools (`get_recent_security_events`, `explain_threat`, `get_threat_reputation_detail`). The system instruction now explicitly requires the assistant to label which kind of answer it's giving — "per Inaya's security documentation" vs. "based on current network data" — never blending the two into one unlabeled claim.
- **Learn** (`/api/ai/learn-chat`): gained `search_learn_knowledge`, which prioritizes the CURRENT video's own transcript (lazily fetched and indexed on first access — see below) before falling back to wider Learn config content and Docs. The tutor keeps its existing "use general knowledge for general teaching" philosophy, but now grounds and cites anything specific to Inaya or to the actual video content, rather than guessing.

## Video transcripts — the real gap this closes, and its honest cost

Inaya Learn had no lesson/transcript content at all before this — it's a YouTube discovery/bookmark layer, not an authored curriculum. `youtubeTranscript.js` fetches a video's public caption track via the same mechanism the YouTube player itself uses (not the official Data API, which only lets a video's own channel owner download captions via OAuth — useless for arbitrary third-party videos). **This is deliberately flagged, not hidden:** it's unofficial, undocumented surface that could break if YouTube changes its page structure, and downloading third-party caption text sits in a ToS gray area beyond normal playback. Every failure mode (no captions, private/restricted video, network error, a structure change) returns `null` and the tutor falls back to exactly its pre-existing general-knowledge behavior for that video — this was a deliberate scope decision, confirmed with the product owner, not a silent default.

## Hallucination protection — calibrated against real data, not guessed

The relevance threshold gating "has real results" vs. "insufficient information" (`retrieve.js`'s `DEFAULT_MIN_RELEVANCE`) was measured directly against this project's own live Atlas cluster and `gemini-embedding-001`, not assumed: a genuinely relevant query/chunk pair scored ~0.89–0.91 cosine similarity; multiple genuinely irrelevant queries (including a same-product-but-wrong-topic query) against the same chunk all scored ~0.72–0.77. The threshold (0.80) sits with real margin in that gap, biased toward the safe failure mode — a false "I don't know" over a false confident answer. An earlier implementation also treated any text-search keyword hit as automatically sufficient; a live test caught this being too permissive (Atlas Search returns weak common-word matches too, not just meaningful exact-term hits) and it was removed — hybrid search still improves *ranking*, it no longer overrides the relevance gate. Revisit this number against `/admin/rag`'s real low-relevance-retrieval stats once the full production corpus and real usage data exist.

## Security controls

- **Prompt injection:** `sanitize.js` neutralizes instruction-like patterns ("ignore previous instructions," fake role markers) in every retrieved chunk before it's interpolated into a prompt, and wraps the whole context block in an explicit, hard-to-spoof delimiter each system instruction is told to treat as reference data, never instructions.
- **Malicious/poisoned documents:** every ingestion source is content this team already controls, except YouTube transcripts (third-party text) — those get the identical sanitization pass as everything else before use.
- **Cross-user leakage:** structurally impossible for the reasons in "Permission model" above — there is nothing private in the retrieval path to leak.

## Freshness

`POST /api/admin/rag/reingest` (admin-triggered) and `GET /api/cron/rag-reingest` (nightly, `CRON_SECRET`-gated, same pattern as the existing `checkpoint-reputation` cron) both run the same incremental pipeline: content-hash diffing means only genuinely changed chunks get re-embedded, and chunks whose source content disappeared get deleted — never a full rebuild. Video transcripts are ingested lazily per-video on first access and never go stale (a transcript doesn't change once posted).

## Monitoring

`/admin/rag` (passphrase-gated, same session as every other `/admin/*` page) shows: total indexed chunks per domain, retrieval success rate/latency/percentiles per domain over the last 7 days, no-result vs. low-relevance-retrieval counts, a "frequently unanswered questions" rollup (the real documentation-gap signal), source freshness, and recent indexing failures. Follows the established honest-null convention — an unavailable stat reads "Unavailable," never a fabricated 0.

## Verified, not just written

- `node --env-file=.env.local --test test/rag-*.test.mjs` — 28/28 tests pass against the real Atlas cluster and real Gemini embedding calls: chunking shape, content-hash diffing (insert/update/skip/remove-obsolete), end-to-end hybrid retrieval (both exact-keyword and semantic-paraphrase queries find a real ingested fixture), domain isolation, the calibrated relevance threshold correctly rejecting irrelevant queries, prompt-injection sanitization, the structural private-data exclusion check, source attribution, and graceful transcript-fetch failure handling.
- The full pre-existing test suite (154 individual test cases across 13 other files, run alongside the new RAG tests) passes with zero regressions. Two pre-existing files (`security.test.mjs`, `watcher-pioneer.test.mjs`) have a known, pre-existing environmental limitation unrelated to this work — their real test assertions pass, but their processes don't exit cleanly in this environment because they attempt a live BNB Chain Testnet RPC connection this sandbox can't reach; this was true before this work started and doesn't touch anything RAG changed.
- `npm run build` compiles the production app cleanly with every new route/component.

## Explicitly out of scope (this pass)

- No warehouse of KNOWLEDGE_ARTICLES (`src/app/page.js`'s ~1,950-line blog-article constant) ingestion — not extracted into its own shared module in this pass to avoid a risky large edit to the main dApp page under time constraints; `INAYA_KNOWLEDGE_BASE` already covers the same ground at a curated-summary level. Real follow-up: extract it into `src/lib/knowledgeArticles.js` (the same pattern `learnConfig.js`/`saasRoadmap.js` already use) so both `page.js` and a docs adapter can share one source.
- No `custody-sdk/SDK_GUIDE.md`/`README.md` ingestion — `custody-sdk` is a separately-hosted, git-excluded repo not present on the deployed server (the exact class of bug that broke this project's production build twice before this session; not risking a repeat for a supplementary knowledge source).
- No native MongoDB `$rankFusion` hybrid stage — hybrid merge is done via Reciprocal Rank Fusion in application code instead, since it works on any Atlas cluster that supports Vector Search at all, not only ones with a specific newer feature.
- No quiz/knowledge-testing content generation beyond what the Learn Tutor's existing general-knowledge teaching already supports — no authored quiz bank exists in this codebase to ground one in.
