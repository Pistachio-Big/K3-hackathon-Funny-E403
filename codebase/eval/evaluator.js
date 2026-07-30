#!/usr/bin/env node
/**
 * evaluator.js — Benchmark hệ thống VLearn Tutor AI với golden set
 *
 * Pipeline:
 *   1. Load golden-set.json + chunks.json + embeddings.json (hoặc dùng Qdrant)
 *   2. Với mỗi case trong golden set:
 *      - Search top-K chunks bằng cosine similarity
 *      - Gọi Gemini để trả lời dựa trên context
 *   3. Đánh giá kết quả theo các chiều chất lượng
 *   4. Xuất eval/run-1.csv
 *
 * Biến môi trường:
 *   OPENROUTER_API_KEY (bắt buộc)
 *   EVAL_MODEL (mặc định: anthropic/claude-3-haiku)
 *   QDRANT_URL (mặc định http://localhost:6333)
 *   EVAL_MODE=local  (dùng embeddings.json local)
 *   EVAL_MODE=qdrant (dùng Qdrant vector DB)
 *
 * Chạy:
 *   node evaluator.js              # chạy full eval
 *   node evaluator.js --dry-run   # chỉ chạy 3 case đầu để test
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
require("./loadenv.js");

const GOLDEN_SET = path.resolve(__dirname, "golden-set.json");
const CHUNKS = path.resolve(__dirname, "chunks.json");
const EMBEDDINGS = path.resolve(__dirname, "embeddings.json");
const OUTPUT = path.resolve(__dirname, "../eval/run-1.csv");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const EVAL_MODE = process.env.EVAL_MODE || "local";
const IS_DRY_RUN = process.argv.includes("--dry-run");
const LLM_MODEL = process.env.EVAL_MODEL || "anthropic/claude-3-haiku";

if (!OPENROUTER_API_KEY) {
  console.error("⚠ OPENROUTER_API_KEY chưa set!");
  process.exit(1);
}

// ============== COSINE SIMILARITY ==============
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ============== TF-IDF EMBEDDING (FALLBACK) ==============
function buildTfIdf(chunks) {
  const vocab = new Map();
  const docs = chunks.map(c => {
    const tokens = c.text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter(w => w.length > 1);
    for (const t of tokens) vocab.set(t, (vocab.get(t) || 0) + 1);
    return tokens;
  });
  const top = [...vocab.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 768)
    .map(e => e[0]);
  const ix = new Map(top.map((w, i) => [w, i]));

  return chunks.map((c, idx) => {
    const vec = new Array(768).fill(0);
    const tokens = docs[idx];
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [w, n] of tf) {
      const i = ix.get(w);
      if (i !== undefined) vec[i] = n / tokens.length;
    }
    return { code: c.code, vec };
  });
}

// ============== SEARCH ==============
let tfidfVecs = null;
let chunkMap = null;

function initSearch(chunks) {
  console.log("→ Khởi tạo TF-IDF vectors...");
  tfidfVecs = buildTfIdf(chunks);
  chunkMap = new Map(chunks.map(c => [c.code, c]));
}

function searchLocal(query, topK = 5) {
  const queryTokens = query.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(w => w.length > 1);

  // Simple word overlap scoring
  const scores = tfidfVecs.map(({ code, vec }) => {
    const chunk = chunkMap.get(code);
    const text = chunk.text.toLowerCase();
    let match = 0;
    for (const t of queryTokens) {
      if (text.includes(t)) match++;
    }
    return { code, score: match / queryTokens.length };
  });

  return scores
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => ({ id: s.code, score: s.score, payload: chunkMap.get(s.code) }));
}

// ============== OPENROUTER API ==============
function callLLM(prompt, context) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: LLM_MODEL,
      messages: [{
        role: "user",
        content: `Bạn là trợ giảng AI của khóa học VLearn.

NGỮ CẢNH TỪ TÀI LIỆU:
${context}

CÂU HỎI: ${prompt}

Trả lời dựa trên ngữ cảnh trên. Nếu không có thông tin, hãy thừa nhận rõ ràng.`
      }],
      temperature: 0.3,
      max_tokens: 500
    });

    const req = https.request({
      method: "POST",
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://vlearn.edu",
        "X-Title": "VLearn Tutor Eval"
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`OpenRouter HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const j = JSON.parse(data);
          resolve(j.choices?.[0]?.message?.content || "Không có phản hồi");
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ============== EVALUATION ==============
function evaluate(response, groundTruth) {
  const result = {
    has_citation: false,
    cite_format_ok: false,
    content_accurate: false,
    safe_not_guess: true,
    mentions_unknown: false,
    overall_pass: false
  };

  // Check citation format [trang XX]
  const citePattern = /\[?trang\s*(\d+)\]?/gi;
  const cites = response.match(citePattern) || [];
  result.has_citation = cites.length > 0;

  // Check if cites are numbers
  const citeNumbers = cites.map(c => {
    const m = c.match(/\d+/);
    return m ? parseInt(m[0]) : 0;
  });
  result.cite_format_ok = citeNumbers.every(n => n >= 1 && n <= 100);

  // Check content accuracy (basic keyword matching)
  const expectedTopics = groundTruth.expected_topics || [];
  if (expectedTopics.length > 0) {
    const responseLower = response.toLowerCase();
    const matchedTopics = expectedTopics.filter(t =>
      responseLower.includes(t.toLowerCase())
    );
    result.content_accurate = matchedTopics.length >= expectedTopics.length * 0.5;
  } else {
    // No specific topics expected - check if appropriately vague
    result.content_accurate = true;
  }

  // Check if mentions not knowing
  const unknownPhrases = [
    "không tìm thấy", "không có thông tin", "không có trong tài liệu",
    "ngoài phạm vi", "không liên quan", "tôi không biết"
  ];
  result.mentions_unknown = unknownPhrases.some(p =>
    response.toLowerCase().includes(p)
  );

  // Safe if mentions unknown OR has relevant content
  const hasRelevantContent = expectedTopics.length === 0 ||
    expectedTopics.some(t => response.toLowerCase().includes(t.toLowerCase()));
  result.safe_not_guess = result.mentions_unknown || hasRelevantContent;

  // Overall pass
  result.overall_pass = result.safe_not_guess && (result.content_accurate || result.mentions_unknown);

  return result;
}

// ============== MAIN ==============
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("=== VLearn Tutor AI Evaluator ===\n");

  // Load data
  console.log("→ Load golden set...");
  const goldenSet = JSON.parse(fs.readFileSync(GOLDEN_SET, "utf-8"));

  console.log("→ Load chunks...");
  const chunks = JSON.parse(fs.readFileSync(CHUNKS, "utf-8"));

  // Initialize search
  initSearch(chunks);

  // Filter for dry run
  const cases = IS_DRY_RUN ? goldenSet.slice(0, 3) : goldenSet;
  console.log(`→ Sẽ eval ${cases.length} case (mode: ${EVAL_MODE})${IS_DRY_RUN ? " [DRY RUN]" : ""}\n`);

  const results = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    console.log(`[${i + 1}/${cases.length}] ${c.id}: ${c.question.slice(0, 50)}...`);

    try {
      // Search relevant chunks
      const searchResults = searchLocal(c.question, 5);

      // Build context from top results
      const context = searchResults
        .slice(0, 3)
        .map(r => `[${r.id}] ${r.payload.text.slice(0, 300)}...`)
        .join("\n\n");

      // Call LLM via OpenRouter
      const response = await callLLM(c.question, context);

      // Evaluate
      const evalResult = evaluate(response, c);

      results.push({
        id: c.id,
        layer: c.layer,
        question: c.question.slice(0, 60),
        has_citation: evalResult.has_citation,
        cite_format_ok: evalResult.cite_format_ok,
        content_accurate: evalResult.content_accurate,
        safe_not_guess: evalResult.safe_not_guess,
        overall_pass: evalResult.overall_pass,
        expected_acceptable: c.is_acceptable,
        response_preview: response.slice(0, 100)
      });

      console.log(`   ✓ Pass: ${evalResult.overall_pass} | Citation: ${evalResult.has_citation}`);

    } catch (e) {
      console.error(`   ✗ Lỗi: ${e.message}`);
      results.push({
        id: c.id,
        layer: c.layer,
        question: c.question.slice(0, 60),
        has_citation: false,
        cite_format_ok: false,
        content_accurate: false,
        safe_not_guess: false,
        overall_pass: false,
        expected_acceptable: c.is_acceptable,
        response_preview: `ERROR: ${e.message.slice(0, 80)}`
      });
    }

    await sleep(500); // Rate limit
  }

  // Write CSV
  const header = "id,layer,question,has_citation,cite_format_ok,content_accurate,safe_not_guess,overall_pass,expected_acceptable,response_preview\n";
  const rows = results.map(r =>
    [
      r.id,
      r.layer,
      `"${r.question.replace(/"/g, '""')}"`,
      r.has_citation,
      r.cite_format_ok,
      r.content_accurate,
      r.safe_not_guess,
      r.overall_pass,
      r.expected_acceptable,
      `"${r.response_preview.replace(/"/g, '""')}"`
    ].join(",")
  );

  const csv = header + rows.join("\n");
  fs.writeFileSync(OUTPUT, csv);

  // Summary
  const passCount = results.filter(r => r.overall_pass).length;
  const totalCount = results.length;

  console.log("\n=== SUMMARY ===");
  console.log(`Total: ${totalCount} | Pass: ${passCount} | Fail: ${totalCount - passCount}`);
  console.log(`Pass rate: ${(passCount / totalCount * 100).toFixed(1)}%`);

  // Breakdown by layer
  const byLayer = {};
  for (const r of results) {
    if (!byLayer[r.layer]) byLayer[r.layer] = { pass: 0, total: 0 };
    byLayer[r.layer].total++;
    if (r.overall_pass) byLayer[r.layer].pass++;
  }

  console.log("\nBy Layer:");
  for (const [layer, data] of Object.entries(byLayer)) {
    const rate = data.total > 0 ? (data.pass / data.total * 100).toFixed(1) : 0;
    console.log(`  ${layer}: ${data.pass}/${data.total} (${rate}%)`);
  }

  console.log(`\n→ Results written to ${OUTPUT}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
