#!/usr/bin/env node
/**
 * research.js — Tìm kiếm tài liệu từ Internet khi dữ liệu local không đủ
 *
 * Module này cung cấp:
 *   1. webResearch(question, keywords) - Tìm kiếm web và trả về kết quả + nguồn
 *   2. checkSufficientContext(topChunks, question) - Đánh giá context có đủ không
 *   3. isResearchNeeded(question, topChunks, threshold) - Quyết định có cần research không
 *
 * Khi nào gọi research:
 *   - Retrieval trả về quá ít kết quả (top < 3)
 *   - Score thấp hơn ngưỡng (Qdrant < 0.5, TF-IDF < 0.3)
 *   - Context mơ hồ, không đủ chi tiết để trả lời
 *
 * Usage:
 *   const { webResearch, checkSufficientContext } = require('./research.js');
 *   const results = await webResearch("câu hỏi", ["keyword1", "keyword2"]);
 */

const https = require("https");

const TRACE_DIR = require("path").resolve(__dirname, "traces");
const fs = require("fs");

// ============== CONFIG ==============
// Ngưỡng quyết định có cần research hay không
const CONTEXT_SCORE_THRESHOLD = 0.3;      // Score tối thiểu của top-1 chunk
const MIN_RELEVANT_CHUNKS = 3;            // Số chunks tối thiểu cần có
const CONTEXT_COVERAGE_THRESHOLD = 0.4;   // % keywords có trong context

// Tavily API key - load từ .env
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || process.env.GEMINI_API_KEY; // fallback

// Keywords cần thiết để trả lời (đoán đơn giản bằng token overlap)
// Nếu < 40% keywords của question có trong context → cần research
const WEAK_ANSWER_PATTERNS = [
  "không rõ", "không biết", "không tìm thấy", "không đề cập",
  "mơ hồ", "thiếu thông tin", "không đủ", "ngoài phạm vi"
];

// ============== CONTEXT QUALITY CHECK ==============

/**
 * Đánh giá xem context từ retrieval có đủ để trả lời câu hỏi không
 * @param {Array} topChunks - Kết quả retrieval [{code, score}]
 * @param {string} question - Câu hỏi gốc
 * @param {string} mode - "qdrant" hoặc "tfidf"
 * @returns {Object} { sufficient, score, reasons, details }
 */
function checkSufficientContext(topChunks, question, mode = "qdrant") {
  const details = {
    chunkCount: topChunks.length,
    topScore: topChunks[0]?.score || 0,
    questionTokens: 0,
    matchedTokens: 0,
    hasLowScoreChunk: false,
    lowScoreCount: 0
  };

  // 1. Kiểm tra số lượng chunks
  if (topChunks.length < MIN_RELEVANT_CHUNKS) {
    return {
      sufficient: false,
      score: 0.2,
      reasons: [`Chỉ có ${topChunks.length} chunks liên quan, cần tối thiểu ${MIN_RELEVANT_CHUNKS}`],
      details
    };
  }

  // 2. Kiểm tra score của top chunks
  const threshold = mode === "qdrant" ? 0.4 : 0.5;
  details.lowScoreCount = topChunks.filter(c => c.score < threshold).length;
  details.hasLowScoreChunk = details.lowScoreCount > 0;

  if (topChunks[0].score < CONTEXT_SCORE_THRESHOLD) {
    return {
      sufficient: false,
      score: 0.3,
      reasons: [`Top-1 score (${topChunks[0].score.toFixed(3)}) thấp hơn ngưỡng (${CONTEXT_SCORE_THRESHOLD})`],
      details
    };
  }

  // 3. Kiểm tra độ phủ của question keywords trong context
  const questionTokens = question.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(w => w.length > 2);

  details.questionTokens = questionTokens.length;

  // Tính context coverage (sẽ được update bên ngoài với chunk texts)
  return {
    sufficient: topChunks.length >= MIN_RELEVANT_CHUNKS && topChunks[0].score >= CONTEXT_SCORE_THRESHOLD,
    score: topChunks[0].score,
    reasons: [],
    details
  };
}

/**
 * Quyết định có nên gọi research hay không
 * @param {Array} topChunks - Kết quả retrieval
 * @param {string} question - Câu hỏi
 * @param {string} mode - "qdrant" hoặc "tfidf"
 * @returns {boolean}
 */
function isResearchNeeded(topChunks, question, mode = "qdrant") {
  // 1. Context quá yếu
  const contextCheck = checkSufficientContext(topChunks, question, mode);
  if (!contextCheck.sufficient) return true;

  // 2. Câu hỏi có patterns cho thấy cần thêm thông tin
  const qLower = question.toLowerCase();
  const isWeakQuestion = WEAK_ANSWER_PATTERNS.some(p => qLower.includes(p));
  if (isWeakQuestion) return true;

  // 3. Câu hỏi quá ngắn hoặc quá chung chung
  const wordCount = question.split(/\s+/).length;
  if (wordCount < 5) return true;

  return false;
}

// ============== WEB RESEARCH (Server-side) ==============

/**
 * Tìm kiếm web bằng Tavily API
 * @param {string} query - Câu truy vấn tìm kiếm
 * @param {Object} options - { limit: số kết quả, language: "vi|en" }
 * @returns {Promise<Array>} [{ title, url, snippet, relevance }]
 */
async function webSearch(query, options = {}) {
  const { limit = 5, language = "vi" } = options;

  // Thử Tavily trước
  if (TAVILY_API_KEY) {
    try {
      return await webSearchTavily(query, { limit, language });
    } catch (e) {
      console.warn(`[webSearch] Tavily failed: ${e.message}`);
    }
  }

  // Fallback: DuckDuckGo
  try {
    return await webSearchDuckDuckGo(query, { limit });
  } catch (e) {
    console.warn(`[webSearch] DuckDuckGo failed: ${e.message}`);
  }

  // Final fallback: mock results
  return getMockSearchResults(query);
}

/**
 * Tavily Search API
 */
async function webSearchTavily(query, options = {}) {
  const { limit = 5, language = "vi" } = options;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "basic",
      max_results: limit,
      include_answer: true,
      include_raw_content: false,
      include_images: false,
    });

    const req = https.request(
      {
        method: "POST",
        hostname: "api.tavily.com",
        path: "/search",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Tavily HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            return;
          }
          try {
            const j = JSON.parse(data);
            const results = (j.results || []).slice(0, limit).map((item, i) => ({
              title: item.title || "",
              url: item.url || "",
              snippet: item.content || item.snippet || "",
              relevance: 1 - (i * 0.1), // Tavily không có relevance score
            }));

            // Tavily cũng trả về answer nếu có
            if (j.answer) {
              results.push({
                title: "Tavily AI Answer",
                url: "",
                snippet: j.answer,
                relevance: 0.95,
                isAnswer: true,
              });
            }

            resolve(results);
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * DuckDuckGo Search (fallback)
 */
async function webSearchDuckDuckGo(query, options = {}) {
  const { limit = 5 } = options;

  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://ddg-api.duckduckgo-stream.com/search?q=${encodedQuery}&format=json&limit=${limit}`;

    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const results = data
            .split("\n")
            .filter((line) => line.trim())
            .slice(0, limit)
            .map((line) => {
              try {
                const item = JSON.parse(line);
                return {
                  title: item.title || "",
                  url: item.url || "",
                  snippet: item.description || item.snippet || "",
                  relevance: item.relevance || 0.5,
                };
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          resolve(results);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}

/**
 * Mock search results khi API không hoạt động
 */
function getMockSearchResults(query) {
  return [
    {
      title: `Tìm kiếm: ${query}`,
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      snippet: `Không thể kết nối đến máy chủ tìm kiếm. Vui lòng thử lại sau.`,
      relevance: 0.1
    }
  ];
}

/**
 * Tạo prompt để LLM đánh giá context và quyết định có cần research
 * @param {string} question - Câu hỏi
 * @param {Array} topChunks - Kết quả retrieval
 * @returns {string} Prompt cho LLM
 */
function buildResearchDecisionPrompt(question, topChunks, chunkTexts) {
  const ctx = topChunks
    .map((c, i) => `[${i + 1}] ${chunkTexts[i] || "(nội dung không có)"}`)
    .join("\n\n");

  return `Bạn là chuyên gia đánh giá chất lượng câu trả lời.

Hãy đánh giá xem context dưới đây có đủ để trả lời câu hỏi không.

CÂU HỎI: ${question}

CONTEXT HIỆN CÓ:
${ctx}

Đánh giá theo thang điểm 1-5:
1 = Không liên quan, không thể trả lời
2 = Liên quan yếu, cần thêm thông tin
3 = Trả lời được nhưng thiếu chi tiết
4 = Trả lời được tốt
5 = Trả lời hoàn hảo

Trả lời theo format JSON:
{
  "score": <1-5>,
  "needs_research": <true/false>,
  "reason": "<giải thích ngắn>",
  "missing_topics": ["<chủ đề thiếu>"]
}`;
}

/**
 * Gọi LLM để quyết định có cần research
 * @param {string} question
 * @param {Array} topChunks
 * @param {Array} chunkTexts
 * @returns {Promise<Object>}
 */
async function askResearchDecision(question, topChunks, chunkTexts) {
  // Sử dụng OpenRouter API nếu có key
  const openrouter = require("./openrouter.js");
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  if (!apiKey) {
    // Fallback: dùng heuristic
    const check = checkSufficientContext(topChunks, question);
    return {
      score: check.score * 5,
      needs_research: !check.sufficient,
      reason: check.reasons.join("; ") || "Sử dụng heuristic",
      missing_topics: []
    };
  }

  const prompt = buildResearchDecisionPrompt(question, topChunks, chunkTexts);

  try {
    const text = await openrouter.chat(prompt, { temperature: 0.1, max_tokens: 200 });
    // Parse JSON từ response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    return { score: 3, needs_research: false, reason: "Parse failed", missing_topics: [] };
  } catch (e) {
    return { score: 3, needs_research: false, reason: "API error: " + e.message, missing_topics: [] };
  }
}

// ============== MAIN RESEARCH FUNCTION ==============

/**
 * Thực hiện research từ web khi cần thiết
 * @param {string} question - Câu hỏi gốc
 * @param {Array} topChunks - Kết quả retrieval [{code, score}]
 * @param {string} mode - "qdrant" hoặc "tfidf"
 * @param {Object} options - { forceResearch: boolean }
 * @returns {Promise<Object>} { needed, results, sources, mergedContext }
 */
async function webResearch(question, topChunks, mode = "qdrant", options = {}) {
  const { forceResearch = false } = options;
  const trace = { question, topChunks: topChunks.map(c => ({ code: c.code, score: c.score })) };

  // 1. Check if research is needed
  const shouldResearch = forceResearch || isResearchNeeded(topChunks, question, mode);

  if (!shouldResearch) {
    return {
      needed: false,
      results: [],
      sources: [],
      mergedContext: null,
      trace
    };
  }

  console.log(`[research] Triggered for: "${question.slice(0, 50)}..."`);

  // 2. Tạo search query từ câu hỏi
  const searchQueries = generateSearchQueries(question, topChunks);

  // 3. Thực hiện search song song
  const searchPromises = searchQueries.map(q => webSearch(q, { limit: 5 }));
  const searchResults = await Promise.allSettled(searchPromises);

  // 4. Merge kết quả
  const allResults = [];
  const seenUrls = new Set();

  for (const result of searchResults) {
    if (result.status === "fulfilled" && result.value) {
      for (const item of result.value) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          allResults.push(item);
        }
      }
    }
  }

  // 5. Format sources
  const sources = allResults.slice(0, 5).map((r, i) => ({
    id: `S${i + 1}`,
    title: r.title,
    url: r.url,
    snippet: r.snippet.slice(0, 300)
  }));

  // 6. Tạo merged context (gồm chunks + web results)
  const webContext = sources
    .map((s, i) => `[Nguồn ${i + 1}] ${s.title}\nURL: ${s.url}\nNội dung: ${s.snippet}`)
    .join("\n\n");

  trace.sourcesFound = sources.length;
  trace.queriesUsed = searchQueries;

  return {
    needed: true,
    results: allResults,
    sources,
    mergedContext: webContext,
    trace
  };
}

/**
 * Tạo các search queries từ câu hỏi
 */
function generateSearchQueries(question, topChunks) {
  const queries = [];

  // Query từ câu hỏi gốc
  queries.push(question);

  // Query với keywords quan trọng
  const keywords = extractKeywords(question);
  if (keywords.length > 2) {
    queries.push(keywords.slice(0, 4).join(" "));
  }

  // Query với context hints
  if (topChunks.length > 0) {
    const hint = topChunks[0].code || "";
    queries.push(`${question} ${hint}`);
  }

  // Deduplicate
  return [...new Set(queries)].slice(0, 3);
}

/**
 * Trích xuất keywords từ câu hỏi
 */
function extractKeywords(text) {
  const stopWords = new Set([
    "là", "của", "có", "không", "và", "để", "trong", "cho", "với",
    "theo", "như", "nào", "gì", "ra", "sao", "ở", "được", "hay",
    "thế", "này", "khi", "đã", "từ", "về", "hỏi", "muốn", "cách"
  ]);

  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

// ============== EXPORTS ==============
module.exports = {
  webResearch,
  checkSufficientContext,
  isResearchNeeded,
  webSearch,
  askResearchDecision,
  extractKeywords,
  // Constants for tuning
  CONFIG: {
    CONTEXT_SCORE_THRESHOLD,
    MIN_RELEVANT_CHUNKS,
    CONTEXT_COVERAGE_THRESHOLD
  }
};
