#!/usr/bin/env node
/**
 * rag.js — Core pipeline RAG cho VLearn Tutor
 *
 * Luồng:  query → embed → cosine top-k → Gemini prompt → verifier → result
 *
 * Hai chế độ:
 *   - LIVE  (có GEMINI_API_KEY): embed query bằng Gemini + gọi Gemini sinh câu trả lời
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
 *   GEMINI_API_KEY   — để bật LIVE mode
 *
 * Chạy CLI: node codebase/eval/rag.js "Câu hỏi của bạn?"
 *   (không có key sẽ tự chạy FALLBACK để bạn xem flow + verifier có hoạt động)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const qdrant = require("./qdrant.js");
const { webResearch, checkSufficientContext, isResearchNeeded } = require("./research.js");
require("./loadenv.js"); // load GEMINI_API_KEY từ .env nếu chưa có

const CHUNKS = path.resolve(__dirname, "chunks.json");
const TRACE_DIR = path.resolve(__dirname, "traces");
const TOP_K = 5;

const apiKey = process.env.GEMINI_API_KEY;
const MODEL_EMBED = "text-embedding-004";
const MODEL_GEN = "gemini-3-flash"; // fallback nếu key không đủ quota cho model lớn hơn
const DIM = 768;

// Ngưỡng tối thi thiểu để coi như retrieval "có thật" — nếu top-1 dưới ngưỡng này → fail-safe
// - Qdrant + Gemini embed: 0.5 (semantic hiểu nghĩa tốt)
// - TF-IDF fallback: cao hơn (vì naive)
const THRESHOLD_QDRANT = 0.5;
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
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      requests: [
        {
          model: `models/${MODEL_EMBED}`,
          content: { parts: [{ text }] },
          taskType: "RETRIEVAL_QUERY",
          outputDimensionality: DIM,
        },
      ],
    });
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_EMBED}:batchEmbedContents?key=${apiKey}`
    );
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(`embed HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          try {
            resolve(JSON.parse(data).embeddings[0].values);
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
  // 1. Ưu tiên Qdrant + Gemini embed (semantic, nhanh)
  if (apiKey) {
    try {
      const qdrantHealth = await qdrant.health();
      if (qdrantHealth.ok) {
        const n = await qdrant.count();
        if (n > 0) {
          const qv = await embedQueryLive(query);
          const results = await qdrant.search(qv, TOP_K);
          return { mode: "qdrant", top: results.map((r) => ({ code: r.payload.code, score: r.score })) };
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

// ============== GENERATE (LIVE) ==============
function callGemini(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
    });
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_GEN}:generateContent?key=${apiKey}`
    );
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(`gen HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          try {
            const j = JSON.parse(data);
            const txt = j.candidates?.[0]?.content?.parts?.[0]?.text || "";
            resolve(txt);
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

QUY TẮC BẮT BUỘC:
1. Câu trả lời phải dựa trên context. Mỗi phát biểu quan trọng phải kèm mã đoạn ngay trong text.
   - Đoạn bài giảng: [Txx-NNN]
   - Đoạn hội thoại học viên: [Cxxxx-Tyyyy-Q] (câu hỏi) hoặc [Cxxxx-Tyyyy-A] (trả lời)
2. CHỈ được dùng mã đoạn có trong danh sách dưới. KHÔNG được bịa mã.
3. Nếu context không đủ để trả lời, hãy nói thẳng: "Mình không tìm thấy nội dung này trong tài liệu. Bạn nên hỏi giảng viên hoặc mở tài liệu gốc."
4. Văn phong: tutor thân thiện, tiếng Việt tự nhiên, xưng "mình".
5. Ưu tiên trích dẫn từ bài giảng [Txx-NNN]. Hội thoại học viên [Cxxxx] chỉ dùng để bổ sung ngữ cảnh khi bài giảng không có.${researchSection}

CONTEXT (top-${topChunks.length} đoạn liên quan):
${ctx}

CÂU HỎI HỌC VIÊN: ${question}

TRẢ LỜI:`;
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
  const enableResearch = opts.enableResearch !== false; // Mặc định bật research
  const trace = {
    question,
    retrieved: [],
    prompt: null,
    rawAnswer: null,
    verified: null,
    mode: apiKey ? "LIVE" : "FALLBACK",
    research: null
  };

  // 1. Retrieve
  const ret = await retrieve(question);
  const top = ret.top;
  const retMode = ret.mode;
  trace.retrieved = top.map((t) => ({ code: t.code, score: Number(t.score.toFixed(4)) }));
  trace.retrieveMode = retMode;
  const allowedCodes = top.map((t) => t.code);

  // 1a. Threshold check: nếu top-1 score quá thấp → coi như không có context phù hợp
  // Threshold theo retrieve mode (qdrant semantic vs TF-IDF naive)
  const threshold = thresholdForMode(retMode);
  if (!top.length || top[0].score < threshold) {
    trace.verified = { failSafe: `[${retMode}] top-1 score ${top[0]?.score?.toFixed(3) || 0} < threshold ${threshold}` };

    // ========== RESEARCH FALLBACK ==========
    if (enableResearch && apiKey) {
      console.log(`[askTutor] Low score (${top[0]?.score?.toFixed(3)}), attempting web research...`);
      try {
        const researchResult = await webResearch(question, top, retMode);
        trace.research = researchResult.trace;

        if (researchResult.needed && researchResult.mergedContext) {
          // Có kết quả research → dùng làm context thay thế
          const researchPrompt = buildResearchPrompt(question, researchResult.mergedContext, researchResult.sources);
          trace.prompt = researchPrompt;

          const rawAnswer = await callGemini(researchPrompt);
          trace.rawAnswer = rawAnswer;

          // Verify citations từ web sources
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
        "Mình **không tìm thấy nội dung này** trong tài liệu (đã duyệt 6 transcript + 585 hội thoại học viên).\n\n" +
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

  // 2. Generate
  let rawAnswer;
  if (apiKey) {
    try {
      // Nếu đã có enhanced prompt từ research → dùng nó, không build lại
      if (!trace.prompt) {
        const chunkTexts = top.map(t => codeToChunk.get(t.code)?.text || "");
        trace.prompt = buildPrompt(question, top, chunkTexts, researchResult);
      }
      rawAnswer = await callGemini(trace.prompt);
    } catch (e) {
      console.error(`[askTutor] gen failed: ${e.message} — fallback`);
      rawAnswer = fallbackAnswer(question, top);
      trace.mode = "FALLBACK-AFTER-ERROR";
    }
  } else {
    rawAnswer = fallbackAnswer(question, top);
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

  // 3. Verify (lớp ① — Nguồn sự thật)
  const { cleanedAnswer, verifiedCitations, hallucinated } = verifyAnswer(rawAnswer, allowedCodes);
  trace.verified = { verifiedCitations, hallucinated };

  // 4. Fail-safe: nếu không có citation hợp lệ → coi như không tìm thấy
  let isFailure = false;
  let finalAnswer = cleanedAnswer;
  if (verifiedCitations.length === 0) {
    isFailure = true;
    finalAnswer =
      "Mình **không tìm thấy nội dung này** trong tài liệu (đã duyệt 6 transcript + 585 hội thoại học viên).\n\n" +
      "Thay vì đoán và trả lời sai, mình khuyên bạn:\n" +
      "• Hỏi trực tiếp giảng viên hoặc TA trong Discord khoá.\n" +
      "• Hoặc mở tài liệu gốc để tìm.\n\n" +
      "_(Đây là hành vi cố ý của tutor: tránh bịa nguồn — Lớp ① trong spec §5.)_";
    trace.verified.failSafe = "no-valid-citation → MOCK_NOT_FOUND";
  } else if (hallucinated.length > 0) {
    trace.verified.failSafe = `stripped ${hallucinated.length} hallucinated code(s)`;
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
    console.log(`Cách dùng: GEMINI_API_KEY=... node codebase/eval/rag.js "Câu hỏi của bạn"`);
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