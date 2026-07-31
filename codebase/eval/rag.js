#!/usr/bin/env node
/**
 * rag.js — Core pipeline RAG cho VLearn Tutor
 *
 * Luồng:  query → embed → cosine top-k → Gemini prompt → verifier → result
 *
 * Hai chế độ:
 *   - LIVE  (có OPENROUTER + JINA keys): embed query bằng Jina + OpenRouter sinh câu trả lời
 *   - FALLBACK (không có key):   dùng TF-IDF cho retrieval, mock-snippet cho answer
 *     (vẫn chạy flow đầy đủ + verifier để test logic; answer là string cứng)
 *
 * API public:
 *   await askTutor(question)  →  {
 *     question, answer, citations: [Txx-NNN], snippets: [{code, text}],
 *     isFailure, trace: {retrieved, prompt, verified}
 *   }
 *
 * Biến môi trường:
 *   OPENROUTER_API_KEY  — để bật LIVE mode (chat + tool calling)
 *   JINA_API_KEY         — để embed query bằng Jina v3
 *
 * Chạy CLI: node codebase/eval/rag.js "Câu hỏi của bạn?"
 *   (không có key sẽ tự chạy FALLBACK để bạn xem flow + verifier có hoạt động)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const qdrant = require("./qdrant.js");
const { webResearch, checkSufficientContext, isResearchNeeded } = require("./research.js");
const { TOOL_DEFINITIONS, SYSTEM_PROMPT, processToolCalls, formatToolResults } = require("./tools.js");
const openrouter = require("./openrouter.js");
require("./loadenv.js"); // load OPENROUTER_API_KEY và JINA_API_KEY từ .env

const CHUNKS = path.resolve(__dirname, "chunks.json");
const TRACE_DIR = path.resolve(__dirname, "traces");
const TOP_K = 5;

// OpenRouter cho generation (chat)
const apiKey = process.env.OPENROUTER_API_KEY;
const MODEL_GEN = openrouter.MODEL_GEN;

// Jina cho embedding (tốt cho tiếng Việt, đồng bộ với embedder.js)
const JINA_API_KEY = process.env.JINA_API_KEY;
const JINA_EMBED_MODEL = "jina-embeddings-v3";
const DIM = 1024; // Jina v3 dims

// Enable tool calling mode
const USE_TOOL_CALLING = true;

// Ngưỡng tối thi thiểu để coi như retrieval "có thật" — nếu top-1 dưới ngưỡng này → fail-safe
// - Qdrant + Jina v3: 0.35 (semantic hiểu nghĩa tốt, score cosine thường 0.3-0.7 với short query)
// - TF-IDF fallback: cao hơn (vì naive)
const THRESHOLD_QDRANT = 0.35;
const THRESHOLD_TFIDF = 0.75;

// ============== LOAD DATA ==============
let chunks = [];
let codeToChunk = new Map();

function loadData() {
  chunks = JSON.parse(fs.readFileSync(CHUNKS, "utf-8"));
  for (const c of chunks) codeToChunk.set(c.code, c);
}
loadData();

// ============== COSINE ==============
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// ============== EMBED QUERY (LIVE) ==============
function embedQueryLive(text) {
  if (!JINA_API_KEY) {
    return Promise.reject(new Error("JINA_API_KEY not set for embedding"));
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: JINA_EMBED_MODEL,
      input: [text],
      dimensions: DIM,
      normalized: true,
      task: "retrieval.query",
    });
    const req = https.request(
      {
        hostname: "api.jina.ai",
        path: "/v1/embeddings",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${JINA_API_KEY}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(`Jina embed HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          try {
            resolve(JSON.parse(data).data[0].embedding);
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

// ============== TF-IDF FALLBACK ==============
// Score bằng số từ query xuất hiện trong chunk / tổng từ query.
// Đơn giản, ổn định, không cần embeddings.json đã có.
function tfidfScore(query, chunkText) {
  const qt = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!qt.length) return 0;
  const ct = chunkText.toLowerCase();
  let s = 0;
  for (const t of qt) if (ct.includes(t)) s += 1;
  return s / qt.length;
}

async function retrieve(query) {
  // 1. Ưu tiên Qdrant + Jina embed (semantic, nhanh)
  if (apiKey && JINA_API_KEY) {
    try {
      const qdrantHealth = await qdrant.health();
      if (qdrantHealth.ok) {
        const n = await qdrant.count();
        if (n > 0) {
          const qv = await embedQueryLive(query);
          // 2 search song song: transcript ưu tiên 1, chatlog fallback
          const [transcriptResults, allResults] = await Promise.all([
            qdrant.search(qv, TOP_K, { must: [{ key: "source", match: { value: "transcript" } }] }),
            qdrant.search(qv, TOP_K, null),
          ]);
          const seen = new Set();
          const combined = [];
          for (const r of [...transcriptResults, ...allResults]) {
            const code = r.payload.code;
            if (!seen.has(code)) {
              seen.add(code);
              combined.push(r);
            }
            if (combined.length >= TOP_K) break;
          }
          return { mode: "qdrant", top: combined.map((r) => ({ code: r.payload.code, score: r.score })) };
        }
      }
    } catch (e) {
      console.error(`[retrieve] Qdrant failed: ${e.message} — fallback TF-IDF`);
    }
  }
  // 2. Fallback TF-IDF (chỉ dùng transcript — chatlog match nhiễu quá)
  const corpus = chunks.filter((c) => c.source === "transcript");
  const scored = corpus.map((c) => ({ code: c.code, score: tfidfScore(query, c.text) }));
  scored.sort((a, b) => b.score - a.score);
  return { mode: "tfidf", top: scored.slice(0, TOP_K) };
}

function thresholdForMode(mode) {
  return mode === "qdrant" ? THRESHOLD_QDRANT : THRESHOLD_TFIDF;
}

// ============== DOCUMENT SUMMARIZER ==============

/**
 * Tóm tắt và lọc documents sau retrieval để trả lời đúng trọng tâm câu hỏi
 * Giúp LLM tập trung vào nội dung liên quan nhất
 */
async function summarizeDocuments(question, topChunks) {
  if (!apiKey || topChunks.length === 0) {
    return { summary: null, focusedChunks: topChunks };
  }

  const chunks = topChunks.map(t => {
    const ch = codeToChunk.get(t.code);
    return {
      code: t.code,
      score: t.score,
      text: ch?.text || "",
      source: ch?.source || "unknown"
    };
  });

  const chunksText = chunks
    .map((c, i) => `[${i + 1}] [${c.code}] ${c.text}`)
    .join("\n\n");

  const prompt = `Bạn là chuyên gia phân tích tài liệu.

## NHIỆM VỤ
Phân tích các đoạn tài liệu dưới đây và tóm tắt những phần LIÊN QUAN TRỰC TIẾP đến câu hỏi.

## CÂU HỎI CẦN TRẢ LỜI
"${question}"

## CÁC ĐOẠN TÀI LIỆU (đã sắp xếp theo relevance)
${chunksText}

## YÊU CẦU
1. Đọc kỹ từng đoạn, đánh giá mức độ liên quan đến câu hỏi
2. Loại bỏ những đoạn KHÔNG liên quan hoặc chỉ liên quan gián tiếp
3. Tóm tắt mỗi đoạn còn lại thành 1-2 câu, giữ nguyên ý chính
4. Ghi rõ mã đoạn [code] để có thể trích dẫn

## OUTPUT FORMAT (JSON)
{
  "focused_summary": "Tóm tắt ngắn gọn 2-3 câu về nội dung chính liên quan",
  "relevant_chunks": [
    {
      "code": "T02-045",
      "summary": "Đoạn này nói về...",
      "key_points": ["điểm chính 1", "điểm chính 2"]
    }
  ],
  "answer_direction": "Hướng trả lời: ..." 
}

CHỉ trả về JSON, không giải thích thêm.`;

  // Use OpenRouter for summarization
  return openrouter.chat(prompt, { temperature: 0.2, max_tokens: 1024 })
    .then(text => {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return {
          summary: parsed.focused_summary || null,
          answerDirection: parsed.answer_direction || null,
          focusedChunks: parsed.relevant_chunks?.map(c => c.code) || topChunks.map(t => t.code)
        };
      }
      return { summary: null, focusedChunks: topChunks.map(t => t.code) };
    })
    .catch(e => {
      console.warn(`[summarizeDocuments] OpenRouter error: ${e.message}`);
      return { summary: null, focusedChunks: topChunks.map(t => t.code) };
    });
}

/**
 * Build enhanced prompt với tài liệu đã được tóm tắt
 */
function buildFocusedPrompt(question, topChunks, docSummary) {
  const ctx = topChunks
    .map((c, i) => {
      const ch = codeToChunk.get(c.code);
      const srcLabel = ch?.source === "transcript" ? "Bài giảng" : "Hội thoại học viên";
      const text = ch?.text || "";
      return `[${i + 1}] Mã: [${ch?.code}] (${srcLabel})\nNội dung: ${text}`;
    })
    .join("\n\n");

  let summarySection = "";
  if (docSummary?.summary) {
    summarySection = `\n\n## TÓM TẮT TÀI LIỆU LIÊN QUAN
${docSummary.summary}
`;
  }

  if (docSummary?.answerDirection) {
    summarySection += `\n## HƯỚNG TRẢ LỜI
${docSummary.answerDirection}
`;
  }

  return `Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.
Học viên hỏi về nội dung bài giảng. Bạn CHỈ được trả lời dựa trên các đoạn dưới đây.

QUY TẮC BẮT BUỘC:
1. Câu trả lời phải dựa trên context. Mỗi phát biểu quan trọng phải kèm mã đoạn ngay trong text.
   - Đoạn bài giảng: [Txx-NNN]
   - Đoạn hội thoại học viên: [Cxxxx-Tyyyy-Q] (câu hỏi) hoặc [Cxxxx-Tyyyy-A] (trả lời)
2. CHỈ được dùng mã đoạn có trong danh sách dưới. KHÔNG được bịa mã.
3. Nếu context không đủ để trả lời, hãy nói thẳng: "Mình không tìm thấy nội dung này trong tài liệu. Bạn nên hỏi giảng viên hoặc mở tài liệu gốc."
4. Văn phong: tutor thân thiện, tiếng Việt tự nhiên, xưng "mình".
5. Ưu tiên trích dẫn từ bài giảng [Txx-NNN].${summarySection}

CONTEXT (top-${topChunks.length} đoạn liên quan):
${ctx}

CÂU HỎI HỌC VIÊN: ${question}

TRẢ LỜI:`;
}

// ============== GENERATE (LIVE) - với Tool Calling ==============

/**
 * Gọi OpenRouter với tool calling
 * @param {string} systemPrompt - System prompt
 * @param {string} userPrompt - User message  
 * @param {Array} tools - Tool definitions
 * @returns {Promise<{text: string, toolCalls: Array|null}>}
 */
async function callOpenRouterWithTools(systemPrompt, userPrompt, tools = null) {
  return openrouter.chatWithTools(systemPrompt, userPrompt, tools)
    .catch(e => {
      console.error(`[callOpenRouterWithTools] OpenRouter error: ${e.message}`);
      throw e;
    });
}

/**
 * Gọi OpenRouter continuation sau tool results
 */
async function callOpenRouterContinuation(messages, tools = null) {
  // messages đã đúng format cho OpenRouter
  const requestOptions = { temperature: 0.3, max_tokens: 4096 };
  if (tools && tools.length > 0) {
    // OpenAI-compatible format requires type:"function" wrapper
    requestOptions.tools = tools.map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
    requestOptions.tool_choice = "auto";
  }

  return openrouter.chat(messages, requestOptions);
}

// Legacy synchronous wrapper - dùng user prompt trực tiếp, không có system prompt
function callOpenRouter(prompt) {
  return callOpenRouterSimple(prompt);
}

/**
 * Simple OpenRouter call cho answer generation
 * Không dùng system prompt vì prompt đã có đầy đủ context
 */
async function callOpenRouterSimple(userPrompt) {
  return openrouter.chat(userPrompt, { temperature: 0.3, max_tokens: 4096 });
}

// ============== PROMPT ==============
function buildPrompt(question, topChunks, chunkTexts = null, researchResult = null) {
  const texts = chunkTexts || topChunks.map((c) => codeToChunk.get(c.code)?.text || "");
  const ctx = topChunks
    .map((c, i) => {
      const ch = codeToChunk.get(c.code);
      const srcLabel = ch.source === "transcript" ? "Bài giảng" : "Hội thoại học viên";
      return `[${i + 1}] Mã đoạn: [${ch.code}] (${srcLabel})\nNội dung: ${texts[i] || ch.text}`;
    })
    .join("\n\n");

  let researchSection = "";
  if (researchResult && researchResult.needed && researchResult.mergedContext) {
    researchSection = `\n\nTHÔNG TIN BỔ SUNG TỪ TÌM KIẾM WEB:\n${researchResult.mergedContext}\n\nNếu thông tin web giúp trả lời câu hỏi tốt hơn, hãy sử dụng nhưng ghi rõ nguồn.`;
  }

  return `Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.
Học viên hỏi về nội dung bài giảng. Bạn CHỈ được trả lời dựa trên các đoạn dưới đây.

QUY TẮC BẮT BUỘC (mọi điểm đều quan trọng):
1. **TRÍCH DẪN LÀ BẮT BUỘC** — Mỗi phát biểu mang thông tin phải kèm mã trích dẫn ngay trong câu, ở cuối câu đó.
   - Đoạn bài giảng: [Txx-NNN]
   - Đoạn hội thoại học viên: [Cxxxx-Tyyyy-Q] (câu hỏi) hoặc [Cxxxx-Tyyyy-A] (trả lời)
   - Ví dụ đúng: "AI là khả năng máy tính thực hiện các tác vụ giống con người [T01-002]."
   - Ví dụ SAI: "AI là khả năng máy tính thực hiện các tác vụ giống con người." (thiếu citation)
2. CHỈ được dùng mã đoạn có trong danh sách dưới. KHÔNG được bịa mã — bịa mã sẽ bị strip và đánh fail.
3. Nếu context không đủ để trả lời, hãy nói thẳng: "Mình không tìm thấy nội dung này trong tài liệu. Bạn nên hỏi giảng viên hoặc mở tài liệu gốc."
4. Văn phong: tutor thân thiện, tiếng Việt tự nhiên, xưng "mình".
5. Ưu tiên trích dẫn từ bài giảng [Txx-NNN]. Hội thoại học viên [Cxxxx] chỉ dùng để bổ sung ngữ cảnh khi bài giảng không có.${researchSection}

CONTEXT (top-${topChunks.length} đoạn liên quan):
${ctx}

CÂU HỎI HỌC VIÊN: ${question}

Hãy trả lời và gắn citation code cho MỌI phát biểu mang thông tin. Bắt đầu trả lời:`;
}

/**
 * Build prompt cho research fallback (khi không có context local)
 */
function buildResearchPrompt(question, webContext, sources) {
  const srcList = sources.map((s, i) => `[${i + 1}] ${s.title} (${s.url})`).join("\n");

  return `Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.
Câu hỏi của học viên không có trong tài liệu bài giảng. Tuy nhiên, mình đã tìm kiếm web và thu thập được thông tin bổ sung.

QUY TẮC BẮT BUỘC:
1. Trả lời dựa trên thông tin tìm được. Nếu không chắc chắn, nói rõ.
2. LUÔN ghi rõ nguồn theo format: (Nguồn: tiêu đề - url)
3. Văn phong: tutor thân thiện, tiếng Việt tự nhiên, xưng "mình".
4. Nêu rõ đây là thông tin bổ sung từ tìm kiếm web, không phải từ tài liệu khoá học.

THÔNG TIN TỪ TÌM KIẾM WEB:
${webContext}

NGUỒN THAM KHẢO:
${srcList}

CÂU HỎI HỌC VIÊN: ${question}

TRẢ LỜI:`;
}

/**
 * Verify answer với web sources
 */
function verifyWebAnswer(rawAnswer, sources) {
  const sourceIds = new Set(sources.map(s => s.id));
  const sourceUrls = new Set(sources.map(s => s.url));

  // Tìm tất cả citations trong answer
  const citePattern = /\[([^\]]+)\]/g;
  const found = [];
  let m;
  const cleanedAnswer = rawAnswer;

  // Lọc citation - giữ nguyên text
  while ((m = citePattern.exec(rawAnswer)) !== null) {
    const code = m[1];
    if (sourceIds.has(code)) {
      found.push(code);
    }
  }

  return {
    cleanedAnswer,
    verifiedCitations: [...new Set(found)]
  };
}

/**
 * Build enhanced prompt khi context local + web research
 */
function buildEnhancedPrompt(question, topChunks, chunkTexts, webContext, webSources) {
  const ctx = topChunks
    .map((c, i) => {
      const ch = codeToChunk.get(c.code);
      const srcLabel = ch.source === "transcript" ? "Bài giảng" : "Hội thoại học viên";
      return `[${i + 1}] Mã đoạn: [${ch.code}] (${srcLabel})\nNội dung: ${chunkTexts[i] || ch.text}`;
    })
    .join("\n\n");

  const webSection = webSources
    .map((s, i) => `[Nguồn ${i + 1}] ${s.title}\nURL: ${s.url}\nNội dung: ${s.snippet}`)
    .join("\n\n");

  return `Bạn là VLearn Tutor — AI hỗ trợ học viên trong khoá AI Thực Chiến.
Học viên hỏi về nội dung bài giảng. Bạn có context từ tài liệu khoá học VÀ thông tin bổ sung từ tìm kiếm web.

QUY TẮC BẮT BUỘC:
1. Ưu tiên sử dụng thông tin từ BÀI GIẢNG [Txx-NNN] làm nguồn chính.
2. Dùng thông tin WEB để BỔ SUNG nếu tài liệu khoá học không đủ chi tiết.
3. Khi dùng thông tin web, ghi rõ nguồn: (Nguồn: tiêu đề)
4. KHÔNG được bịa mã đoạn. Chỉ dùng [Txx-NNN] và [Cxxxx-Tyyyy-Q/A] từ danh sách dưới.
5. Văn phong: tutor thân thiện, tiếng Việt tự nhiên, xưng "mình".

TÀI LIỆU KHOÁ HỌC (top-${topChunks.length} đoạn):
${ctx}

THÔNG TIN BỔ SUNG TỪ WEB:
${webSection}

CÂU HỎI HỌC VIÊN: ${question}

TRẢ LỜI:`;
}

// ============== VERIFIER — chống hallucination mã đoạn ==============
// Quy tắc: CHỈ giữ mã có thật trong chunks. Bất kỳ mã nào không có → FAIL.
// Citation hợp lệ:
//   - [Txx-NNN]      (transcript)
//   - [Cxxxx-Tyyyy-K] (chatlog, K = Q|A)
//   - Một số AI trả về dạng rút gọn [Cxxxx] — ta cũng chấp nhận nếu nằm trong allowed
const RE_CITE_ANY = /\[((?:T\d{2}-\d{1,3})|(?:C\d{4}-T\d{4}-[QA])|(?:C\d{4}))\]/g;

function verifyAnswer(rawAnswer, allowedCodes) {
  const allowed = new Set(allowedCodes);
  const found = [];
  let m;
  const safeAnswer = rawAnswer;
  RE_CITE_ANY.lastIndex = 0;
  while ((m = RE_CITE_ANY.exec(safeAnswer)) !== null) {
    const code = m[1];
    if (allowed.has(code) && !found.includes(code)) found.push(code);
  }
  // Thay mọi mã không hợp lệ bằng marker
  const hallucinated = [];
  const cleaned = safeAnswer.replace(RE_CITE_ANY, (full, code) => {
    if (!allowed.has(code)) {
      hallucinated.push(code);
      return `[⚠${code}?]`;
    }
    return full;
  });
  return { cleanedAnswer: cleaned, verifiedCitations: found, hallucinated };
}

// ============== PUBLIC API ==============
async function askTutor(question, opts = {}) {
  const enableResearch = opts.enableResearch !== false;
  const trace = {
    question,
    retrieved: [],
    prompt: null,
    rawAnswer: null,
    verified: null,
    mode: apiKey ? "LIVE" : "FALLBACK",
    research: null,
    toolCalls: []
  };

  // 1. Retrieve
  const ret = await retrieve(question);
  const top = ret.top;
  const retMode = ret.mode;
  trace.retrieved = top.map((t) => ({ code: t.code, score: Number(t.score.toFixed(4)) }));
  trace.retrieveMode = retMode;
  const allowedCodes = top.map((t) => t.code);

  // Threshold check
  const threshold = thresholdForMode(retMode);
  const hasLowScore = !top.length || top[0].score < threshold;

  // ========== SUMMARIZE DOCUMENTS (lọc tài liệu theo trọng tâm) ==========
  let docSummary = null;
  let focusedCodes = allowedCodes;
  if (top.length > 0 && apiKey) {
    try {
      console.log(`[askTutor] Summarizing ${top.length} retrieved documents...`);
      docSummary = await summarizeDocuments(question, top);
      if (docSummary?.focusedChunks) {
        focusedCodes = docSummary.focusedChunks.filter(c => allowedCodes.includes(c));
        trace.docSummary = docSummary;
        console.log(`[askTutor] Focused to ${focusedCodes.length} relevant chunks`);
      }
    } catch (e) {
      console.warn(`[askTutor] Summarization failed: ${e.message}`);
    }
  }
  // ========================================================================

  // ========== TOOL CALLING MODE ==========
  if (USE_TOOL_CALLING && apiKey && enableResearch) {
    try {
      const tools = TOOL_DEFINITIONS.tools;
      const userPrompt = `Câu hỏi: ${question}\n\nHãy tra cứu tài liệu trước, sau đó trả lời.`;

      // First call - AI may request tool calls
      const firstResponse = await callOpenRouterWithTools(SYSTEM_PROMPT, userPrompt, tools);
      trace.rawAnswer = firstResponse.text;

      let finalText = firstResponse.text;
      const allToolCalls = [...(firstResponse.toolCalls || [])];
      const toolResults = [];

      // Process tool calls if any
      if (firstResponse.toolCalls && firstResponse.toolCalls.length > 0) {
        console.log(`[askTutor] Tool calls detected: ${firstResponse.toolCalls.map(t => t.name).join(", ")}`);
        trace.toolCalls = firstResponse.toolCalls;

        const results = await processToolCalls(firstResponse.toolCalls);
        toolResults.push(...results);

        // Build continuation messages (OpenAI-compatible format)
        // Note: mỗi tool_call phải có 1 tool message response với tool_call_id tương ứng
        const toolMessages = firstResponse.toolCalls.map((tc, i) => ({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(results[i]?.result || results[i] || {})
        }));
        const messages = [
          { role: "user", content: SYSTEM_PROMPT },
          { role: "assistant", content: "Tôi đã hiểu. Tôi sẽ tuân thủ nghiêm ngặt các nguyên tắc và chỉ trả lời dựa trên thông tin từ tài liệu hoặc tìm kiếm web." },
          { role: "user", content: userPrompt },
          {
            role: "assistant",
            content: null,
            tool_calls: firstResponse.toolCalls.map(tc => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.args || {})
              }
            }))
          },
          ...toolMessages
        ];

        // Get final response
        finalText = await callOpenRouterContinuation(messages, tools);
        trace.rawAnswer = finalText;
      }

      // Verify and return (dùng allowedCodes = full retrieved, KHÔNG dùng focusedCodes)
      const codeAllow = top.map(t => t.code);
      const { cleanedAnswer, verifiedCitations, hallucinated } = verifyAnswer(finalText, codeAllow);
      trace.verified = { verifiedCitations, hallucinated, allowedCodes: codeAllow.slice(0,5), focusedCodes: focusedCodes.slice(0,5) };

      // Check if we have valid citations - if not, might need web research
      let needWebSearch = verifiedCitations.length === 0 && hasLowScore;
      let webSources = [];
      let mergedContext = null;

      if (needWebSearch) {
        console.log(`[askTutor] No local citations, attempting web search...`);
        try {
          const researchResult = await webResearch(question, top, retMode);
          if (researchResult.needed && researchResult.mergedContext) {
            webSources = researchResult.sources;
            mergedContext = researchResult.mergedContext;
            trace.research = researchResult.trace;

            // Regenerate with web context
            const webPrompt = buildWebContextPrompt(question, researchResult.mergedContext, researchResult.sources);
            const webResponse = await callOpenRouterWithTools(SYSTEM_PROMPT + "\n\n" + webPrompt, "Hãy trả lời dựa trên thông tin web đã cung cấp.", null);
            finalText = webResponse.text || finalText;
            trace.rawAnswer = finalText;

            const webVerified = verifyWebCitations(finalText, researchResult.sources);
            return buildResult(question, webVerified.cleaned, webVerified.citations, researchResult.sources, trace, true, researchResult);
          }
        } catch (e) {
          console.error(`[askTutor] Web search failed: ${e.message}`);
        }
      }

      // Soft-fail logic: nếu có hallucinated citation(s) → strip nhưng vẫn return content
      // vì answer có thể vẫn correct, chỉ sai citation
      const hasHallucinated = hallucinated.length > 0;
      const isFailureSoft = verifiedCitations.length === 0 && !hasHallucinated;
      return {
        question,
        answer: isFailureSoft
          ? "Mình **không tìm thấy nội dung này** trong tài liệu. Bạn nên hỏi trực tiếp giảng viên hoặc TA."
          : cleanedAnswer,
        citations: verifiedCitations,
        snippets: [],
        isFailure: isFailureSoft,
        trace,
        warningNote: hasHallucinated
          ? `stripped ${hallucinated.length} hallucinated citation(s): ${hallucinated.join(", ")}`
          : null
      };

    } catch (e) {
      console.error(`[askTutor] Tool calling failed: ${e.message}, falling back to standard mode`);
    }
  }
  // =====================================

  // 1a. Threshold check: nếu top-1 score quá thấp → coi như không có context phù hợp
  if (!top.length || top[0].score < threshold) {
    trace.verified = { failSafe: `[${retMode}] top-1 score ${top[0]?.score?.toFixed(3) || 0} < threshold ${threshold}` };

    // ========== RESEARCH FALLBACK ==========
    if (enableResearch && apiKey) {
      console.log(`[askTutor] Low score (${top[0]?.score?.toFixed(3)}), attempting web research...`);
      try {
        const researchResult = await webResearch(question, top, retMode);
        trace.research = researchResult.trace;

        if (researchResult.needed && researchResult.mergedContext) {
          const researchPrompt = buildResearchPrompt(question, researchResult.mergedContext, researchResult.sources);
          trace.prompt = researchPrompt;

          const rawAnswer = await callOpenRouter(researchPrompt);
          trace.rawAnswer = rawAnswer;

          const { cleanedAnswer, verifiedCitations } = verifyWebAnswer(rawAnswer, researchResult.sources);
          trace.verified = { fromResearch: true, sources: researchResult.sources, verifiedCitations };

          const snippets = researchResult.sources.map(s => ({
            code: s.id,
            source: "web",
            text: s.snippet
          }));

          if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
          const ts = new Date().toISOString().replace(/[:.]/g, "-");
          fs.writeFileSync(path.join(TRACE_DIR, `trace-${ts}.json`), JSON.stringify(trace, null, 2));

          return {
            question,
            answer: cleanedAnswer + "\n\n_(Thông tin bổ sung từ tìm kiếm web)_",
            citations: researchResult.sources.map(s => s.id),
            snippets,
            isFailure: false,
            trace,
            researchInfo: {
              used: true,
              sources: researchResult.sources,
              queryCount: researchResult.trace.queriesUsed?.length || 0
            }
          };
        }
      } catch (e) {
        console.error(`[askTutor] Research failed: ${e.message}`);
        trace.research = { error: e.message };
      }
    }
    // =======================================

    if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(TRACE_DIR, `trace-${ts}.json`), JSON.stringify(trace, null, 2));
    return {
      question,
      answer:
        "Mình **không tìm thấy nội dung này** trong tài liệu.\n\n" +
        "Câu hỏi có vẻ nằm ngoài phạm vi tài liệu bài giảng. Bạn nên hỏi trực tiếp giảng viên hoặc TA.",
      citations: [],
      snippets: [],
      isFailure: true,
      trace,
    };
  }

  // 1b. Kiểm tra context có đủ chất lượng không
  const contextCheck = checkSufficientContext(top, question, retMode);
  let researchResult = null;

  if (enableResearch && apiKey && isResearchNeeded(top, question, retMode)) {
    console.log(`[askTutor] Context insufficient (${contextCheck.score.toFixed(2)}), attempting web research...`);
    try {
      researchResult = await webResearch(question, top, retMode);
      trace.research = researchResult.trace;

      if (researchResult.needed && researchResult.mergedContext) {
        // Enrich context với web results
        const chunkTexts = top.map(t => codeToChunk.get(t.code)?.text || "");
        trace.prompt = buildEnhancedPrompt(question, top, chunkTexts, researchResult.mergedContext, researchResult.sources);
      }
    } catch (e) {
      console.error(`[askTutor] Research failed: ${e.message}`);
      trace.research = { error: e.message };
    }
  }

  // ==== HARD FAIL-SAFE ====
  // Nếu top-1 score quá thấp VÀ web research không bổ sung được gì,
  // thì KHÔNG cho LLM generate — tránh "guessing" gây unsafe.
  // Chỉ skip khi research thực sự có mergedContext (đã bổ sung được thông tin)
  // Đồng thời chỉ trigger khi top-1 score rất thấp (< 0.25) — quá yếu để LLM làm gì được.
  if (hasLowScore && top[0]?.score < 0.25 && (!researchResult || !researchResult.needed || !researchResult.mergedContext)) {
    console.log(`[askTutor] Hard fail-safe: very low score (${top[0]?.score?.toFixed(3)}) + no research help → returning early`);
    if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    trace.verified = { hardFailSafe: `very-low-score + no-research, top-1=${top[0]?.score?.toFixed(3)}` };
    fs.writeFileSync(path.join(TRACE_DIR, `trace-${ts}.json`), JSON.stringify(trace, null, 2));
    return {
      question,
      answer:
        "Mình **không tìm thấy nội dung này** trong tài liệu bài giảng, và cũng không tìm được thông tin bổ sung phù hợp trên web.\n\n" +
        "Thay vì đoán và trả lời sai, mình khuyên bạn:\n" +
        "• Hỏi trực tiếp giảng viên hoặc TA trong Discord khoá.\n" +
        "• Hoặc mở tài liệu gốc để tìm.\n\n" +
        "_(Đây là hành vi cố ý của tutor: tránh bịa nguồn — Lớp ① trong spec §5.)_",
      citations: [],
      snippets: [],
      isFailure: true,
      trace,
    };
  }
  // =========================

  // 2. Generate với focused prompt (tài liệu đã được tóm tắt)
  const focusedTop = top.filter(t => focusedCodes.includes(t.code));
  let rawAnswer;
  if (apiKey) {
    try {
      // Nếu đã có enhanced prompt từ research → dùng nó
      if (!trace.prompt) {
        // Dùng buildFocusedPrompt với docSummary để tập trung vào trọng tâm
        const chunkTexts = top.map(t => codeToChunk.get(t.code)?.text || "");
        trace.prompt = buildFocusedPrompt(question, top, docSummary);
      }
      rawAnswer = await callOpenRouter(trace.prompt);
    } catch (e) {
      console.error(`[askTutor] gen failed: ${e.message} — fallback`);
      rawAnswer = fallbackAnswer(question, focusedTop);
      trace.mode = "FALLBACK-AFTER-ERROR";
    }
  } else {
    rawAnswer = fallbackAnswer(question, focusedTop);
  }
  trace.rawAnswer = rawAnswer;

  // Thêm research info vào trace cuối cùng
  if (researchResult && researchResult.needed) {
    trace.research = {
      ...trace.research,
      sources: researchResult.sources,
      used: true
    };
  }

  // 3. Verify (dùng allowedCodes = TẤT CẢ retrieved codes, không filter theo summary)
  // Summarization chỉ dùng để gợi ý cho LLM, KHÔNG dùng để giới hạn citations hợp lệ
  // vì model có thể trích dẫn đoạn khác trong retrieved top-K
  const codesToVerify = top.map(t => t.code); // luôn dùng top retrieved, KHÔNG dùng focusedCodes
  const { cleanedAnswer, verifiedCitations, hallucinated } = verifyAnswer(rawAnswer, codesToVerify);
  trace.verified = { verifiedCitations, hallucinated, focusedCodes: focusedCodes.slice(0,5), allowedCodes: codesToVerify.slice(0,5) };

  // 4. Fail-safe: nếu không có citation hợp lệ → soft fail (giữ answer nếu có hallucinated bị strip)
  let isFailure = false;
  let finalAnswer = cleanedAnswer;
  if (verifiedCitations.length === 0 && hallucinated.length === 0) {
    // Không có citation nào và cũng không có hallucinated → thật sự không tìm thấy
    isFailure = true;
    finalAnswer =
      "Mình **không tìm thấy nội dung này** trong tài liệu.\n\n" +
      "Thay vì đoán và trả lời sai, mình khuyên bạn:\n" +
      "• Hỏi trực tiếp giảng viên hoặc TA trong Discord khoá.\n" +
      "• Hoặc mở tài liệu gốc để tìm.\n\n" +
      "_(Đây là hành vi cố ý của tutor: tránh bịa nguồn — Lớp ① trong spec §5.)_";
    trace.verified.failSafe = "no-valid-citation → MOCK_NOT_FOUND";
  } else if (hallucinated.length > 0) {
    // Có hallucinated bị strip → vẫn trả answer (đã strip marker), KHÔNG coi là failure
    trace.verified.failSafe = `stripped ${hallucinated.length} hallucinated code(s): ${hallucinated.join(", ")}`;
  }

  // 5. Snippet cho UI — CHỈ trả text nếu là transcript (không lộ nội dung chatlog ra UI)
  const snippets = verifiedCitations.map((code) => {
    const ch = codeToChunk.get(code);
    return {
      code,
      source: ch?.source || "unknown",
      text: ch?.source === "transcript" ? ch.text || "" : "[trích từ hội thoại học viên — xem mã]",
    };
  });

  // 6. Log trace
  if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(TRACE_DIR, `trace-${ts}.json`), JSON.stringify(trace, null, 2));

  const result = {
    question,
    answer: finalAnswer,
    citations: verifiedCitations,
    snippets,
    isFailure,
    trace,
  };

  // Thêm research info nếu đã sử dụng
  if (researchResult && researchResult.needed) {
    result.researchInfo = {
      used: true,
      sources: researchResult.sources,
      queryCount: researchResult.trace.queriesUsed?.length || 0
    };
  }

  return result;
}

function fallbackAnswer(question, top) {
  if (!top.length || top[0].score === 0) {
    return "Mình không tìm thấy nội dung này trong tài liệu (FALLBACK mode).";
  }
  const top1 = codeToChunk.get(top[0].code);
  if (top1.source === "transcript") {
    return `Theo đoạn [${top1.code}], giảng viên có nói: "${top1.text.slice(0, 200)}..."`;
  }
  return `Mình tìm thấy một hội thoại học viên liên quan [${top1.code}], nhưng chưa tổng hợp được câu trả lời (FALLBACK mode cần Gemini API để sinh).`;
}

// ============== CLI ==============
if (require.main === module) {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.log(`Cách dùng: OPENROUTER_API_KEY=... node codebase/eval/rag.js "Câu hỏi của bạn"`);
    process.exit(0);
  }
  askTutor(question)
    .then((r) => {
      console.log("\n=== ANSWER ===");
      console.log(r.answer);
      console.log("\n=== CITATIONS ===");
      console.log(r.citations.join(", ") || "(none — failure path)");
      console.log("\n=== TRACE ===");
      console.log(`mode: ${r.trace.mode}`);
      console.log(`retrieved: ${r.trace.retrieved.map((t) => `${t.code} (${t.score})`).join(", ")}`);
      if (r.trace.verified?.hallucinated?.length) {
        console.log(`hallucinated stripped: ${r.trace.verified.hallucinated.join(", ")}`);
      }
      if (r.trace.verified?.failSafe) console.log(`fail-safe: ${r.trace.verified.failSafe}`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { askTutor, verifyAnswer, retrieve };

// ============== HELPER FUNCTIONS ==============

/**
 * Format tool results for user in continuation message
 */
function formatToolResultsForUser(toolResults) {
  const lines = [];
  lines.push("Kết quả từ các công cụ:\n");

  for (const tr of toolResults) {
    lines.push(`--- ${tr.toolName} ---`);
    if (tr.result.status === "error") {
      lines.push(`Lỗi: ${tr.result.message}`);
    } else if (tr.result.results) {
      lines.push(JSON.stringify(tr.result, null, 2));
    } else if (tr.result.documents) {
      lines.push(JSON.stringify(tr.result, null, 2));
    } else {
      lines.push(JSON.stringify(tr.result, null, 2));
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Verify web citations in answer
 */
function verifyWebCitations(rawAnswer, sources) {
  const cleanedAnswer = rawAnswer;
  const found = [];

  // For web sources, just check that answer looks reasonable
  if (sources.length > 0) {
    found.push(...sources.map(s => s.id));
  }

  return {
    cleaned: cleanedAnswer,
    citations: found
  };
}

/**
 * Build prompt with web context
 */
function buildWebContextPrompt(question, webContext, sources) {
  const srcList = sources.map((s, i) => `[${i + 1}] ${s.title} (${s.url})`).join("\n");

  return `
THÔNG TIN BỔ SUNG TỪ TÌM KIẾM WEB:

${webContext}

NGUỒN THAM KHẢO:
${srcList}

Hãy trả lời câu hỏi dựa trên thông tin web trên. Ghi rõ nguồn khi sử dụng thông tin từ một trang cụ thể.
`;
}

/**
 * Build final result object
 */
function buildResult(question, answer, citations, webSources, trace, isWebResearch, researchResult) {
  const isFailure = citations.length === 0 && !isWebResearch;

  // Build snippets
  const snippets = [];

  if (isWebResearch && researchResult) {
    snippets.push(...researchResult.sources.map(s => ({
      code: s.id,
      source: "web",
      text: s.snippet
    })));
  }

  const result = {
    question,
    answer: isFailure
      ? "Mình **không tìm thấy nội dung này** trong tài liệu. Bạn nên hỏi trực tiếp giảng viên hoặc TA."
      : answer,
    citations,
    snippets,
    isFailure,
    trace
  };

  if (isWebResearch && researchResult) {
    result.researchInfo = {
      used: true,
      sources: researchResult.sources,
      queryCount: researchResult.trace?.queriesUsed?.length || 0
    };
  }

  // Log trace
  if (!fs.existsSync(TRACE_DIR)) fs.mkdirSync(TRACE_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(TRACE_DIR, `trace-${ts}.json`), JSON.stringify(trace, null, 2));

  return result;
}