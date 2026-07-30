#!/usr/bin/env node
/**
 * embedder.js — Embed chunks bằng Jina API
 *
 * Input:  codebase/eval/chunks.json
 * Output: codebase/eval/embeddings.json  [{code, text, embedding: [...]}, ...]
 *
 * Biến môi trường: JINA_API_KEY
 * Chạy: node codebase/eval/embedder.js
 *
 * Lưu ý:
 *   - Cache theo code: nếu embeddings.json đã có code đó thì bỏ qua
 *   - Batch 32 chunk / lần gọi (giới hạn Jina)
 *   - Model: jina-embeddings-v3 (1024 dims)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
require("./loadenv.js");

const CHUNKS = path.resolve(__dirname, "chunks.json");
const OUT = path.resolve(__dirname, "embeddings.json");
const MODEL = "jina-embeddings-v3";
const BATCH = 32;
const DIM = 1024;

const apiKey = process.env.JINA_API_KEY;
if (!apiKey) {
  console.error("⚠ JINA_API_KEY chưa set — sẽ chạy FALLBACK TF-IDF (không cần API).");
  process.exit(1);
}

function postBatch(texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      input: texts,
      dimensions: DIM,
      normalized: true,
      task: "retrieval.passage",
    });
    const req = https.request(
      {
        hostname: "api.jina.ai",
        path: "/v1/embeddings",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          } else {
            try {
              const j = JSON.parse(data);
              resolve(j.data.map((d) => d.embedding));
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

  let done = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    let attempt = 0;
    while (true) {
      try {
        const vecs = await postBatch(batch.map((c) => c.text));
        for (let j = 0; j < batch.length; j++) {
          const code = batch[j].code;
          cache[code] = { code, text: batch[j].text, embedding: vecs[j] };
        }
        done += batch.length;
        console.log(`  ${done}/${missing.length}`);
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 3) {
          console.error(`✗ Lỗi sau 3 lần tại batch ${i}: ${e.message}`);
          process.exit(1);
        }
        console.log(`  ! Retry ${attempt}/3: ${e.message.slice(0, 100)}`);
        await sleep(2000 * attempt);
      }
    }
    await sleep(200);
  }

  const out = chunks.map((c) => cache[c.code]).filter(Boolean);
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`→ Đã ghi ${out.length} embeddings vào ${OUT}`);
  console.log(`→ Vector dim: ${DIM}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
