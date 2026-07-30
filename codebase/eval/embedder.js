#!/usr/bin/env node
/**
 * embedder.js — Embed 700 chunks bằng Gemini text-embedding-004
 *
 * Input:  codebase/eval/chunks.json
 * Output: codebase/eval/embeddings.json  [{code, text, embedding: [...768]}, ...]
 *
 * Biến môi trường: GEMINI_API_KEY
 * Chạy: node codebase/eval/embedder.js
 *
 * Lưu ý:
 *   - Cache theo code: nếu embeddings.json đã có code đó thì bỏ qua
 *   - Batch 100 chunk / lần gọi (giới hạn Gemini batchEmbedContents)
 *   - taskType: RETRIEVAL_DOCUMENT (cho phía tài liệu)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
require("./loadenv.js"); // load GEMINI_API_KEY từ .env

const CHUNKS = path.resolve(__dirname, "chunks.json");
const OUT = path.resolve(__dirname, "embeddings.json");
const MODEL = "text-embedding-004";
const BATCH = 100;
const DIM = 768;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("⚠ GEMINI_API_KEY chưa set — sẽ chạy FALLBACK TF-IDF (không cần API).");
  console.error("  Để có chất lượng tốt hơn, set key rồi chạy lại.");
}

function postBatch(requests) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      requests: requests.map((r) => ({
        model: `models/${MODEL}`,
        content: { parts: [{ text: r.text }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: DIM,
      })),
    });
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents?key=${apiKey}`
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
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          } else {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fallback TF-IDF — chạy khi không có API key.
 * Cho vector 768 chiều cố định, hầu hết = 0. Đủ để demo flow, không đủ để đo chất lượng.
 */
function buildTfIdfFallback(chunks) {
  const vocab = new Map();
  const docs = chunks.map((c) => {
    const tokens = c.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1);
    for (const t of tokens) vocab.set(t, (vocab.get(t) || 0) + 1);
    return tokens;
  });
  // Lấy top 768 từ phổ biến nhất làm chiều vector
  const top = [...vocab.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, DIM)
    .map((e) => e[0]);
  const ix = new Map(top.map((w, i) => [w, i]));

  return chunks.map((c, idx) => {
    const vec = new Array(DIM).fill(0);
    const tokens = docs[idx];
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [w, n] of tf) {
      const i = ix.get(w);
      if (i !== undefined) vec[i] = n / tokens.length;
    }
    return { code: c.code, text: c.text, embedding: vec };
  });
}

async function main() {
  const chunks = JSON.parse(fs.readFileSync(CHUNKS, "utf-8"));
  let cache = {};
  if (fs.existsSync(OUT)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUT, "utf-8"));
      for (const e of existing) cache[e.code] = e;
      console.log(`→ Cache: ${Object.keys(cache).length} embeddings đã có.`);
    } catch {}
  }

  const missing = chunks.filter((c) => !cache[c.code]);
  console.log(`→ Cần embed ${missing.length} đoạn mới (tổng ${chunks.length}).`);

  if (!apiKey) {
    console.log("→ Chạy fallback TF-IDF (chất lượng thấp, chỉ để demo).");
    const fb = buildTfIdfFallback(chunks);
    fs.writeFileSync(OUT, JSON.stringify(fb, null, 0));
    console.log(`→ Đã ghi ${fb.length} embeddings vào ${OUT}`);
    return;
  }

  let done = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    let attempt = 0;
    while (true) {
      try {
        const res = await postBatch(batch);
        for (let j = 0; j < batch.length; j++) {
          const code = batch[j].code;
          cache[code] = { code, text: batch[j].text, embedding: res.embeddings[j].values };
        }
        done += batch.length;
        console.log(`  ${done}/${missing.length}`);
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 3) {
          console.error(`✗ Lỗi sau 3 lần thử tại batch ${i}: ${e.message}`);
          process.exit(1);
        }
        console.log(`  ! Retry ${attempt}/3 sau lỗi: ${e.message.slice(0, 100)}`);
        await sleep(2000 * attempt);
      }
    }
    await sleep(300); // rate limit nhẹ
  }

  const out = chunks.map((c) => cache[c.code]).filter(Boolean);
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`→ Đã ghi ${out.length} embeddings vào ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
