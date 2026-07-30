#!/usr/bin/env node
/**
 * ingest.js — Đẩy toàn bộ chunks vào Qdrant
 *
 * Pipeline:
 *   1. Load chunks.json (transcript + chatlog)
 *   2. ensureCollection (tạo nếu chưa có)
 *   3. Với mỗi chunk: embed bằng Gemini (nếu chưa có trong cache) → upsert
 *   4. Cache embeddings vào qdrant-cache.json (chỉ dùng để skip re-embed khi restart)
 *
 * Cache format:
 *   { "T01-001": [0.012, -0.034, ...], ... }
 *
 * Biến môi trường:
 *   GEMINI_API_KEY (bắt buộc)
 *   QDRANT_URL (mặc định http://localhost:6333)
 *
 * Chạy:
 *   node codebase/eval/ingest.js            # embed + upsert tất cả
 *   node codebase/eval/ingest.js --reset    # xoá collection trước khi upsert
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
require("./loadenv.js");

const { ensureCollection, upsertPoints, count, deleteAll, COLLECTION } = require("./qdrant.js");

const CHUNKS = path.resolve(__dirname, "chunks.json");
const CACHE = path.resolve(__dirname, "qdrant-cache.json");
const MODEL_EMBED = process.env.GEMINI_MODEL_EMBED || "text-embedding-004";
const DIM = 768;
const BATCH = 100;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("⚠ GEMINI_API_KEY chưa set — điền vào codebase/eval/.env");
  process.exit(1);
}

// ============== CACHE ==============
let cache = {};
if (fs.existsSync(CACHE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE, "utf-8"));
  } catch {}
}
function saveCache() {
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}

// ============== EMBED BATCH ==============
function embedBatch(texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${MODEL_EMBED}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: DIM,
      })),
    });
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_EMBED}:batchEmbedContents?key=${apiKey}`
    );
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`embed HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
          try {
            const j = JSON.parse(buf);
            resolve(j.embeddings.map((e) => e.values));
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chunks = JSON.parse(fs.readFileSync(CHUNKS, "utf-8"));
  console.log(`→ Corpus: ${chunks.length} chunks`);

  if (process.argv.includes("--reset")) {
    console.log("→ Reset collection...");
    try {
      await deleteAll();
    } catch (e) {
      console.log(`  (collection chưa tồn tại hoặc lỗi reset: ${e.message})`);
    }
  }

  await ensureCollection();
  const before = await count();
  console.log(`→ Qdrant collection '${COLLECTION}': ${before} vectors`);

  // Cache code có sẵn trong Qdrant để skip re-embed (nếu muốn idempotent)
  // Đơn giản: cache theo file qdrant-cache.json (không gọi Qdrant scroll để tiết kiệm)
  const missing = chunks.filter((c) => !cache[c.code]);
  console.log(`→ Cần embed ${missing.length} chunk mới (cache có ${Object.keys(cache).length}).`);

  let done = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    let attempt = 0;
    while (true) {
      try {
        const vecs = await embedBatch(batch.map((c) => c.text));
        for (let j = 0; j < batch.length; j++) {
          cache[batch[j].code] = vecs[j];
        }
        saveCache();
        done += batch.length;
        console.log(`  embed: ${done}/${missing.length}`);
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 3) {
          console.error(`✗ Lỗi sau 3 lần: ${e.message}`);
          process.exit(1);
        }
        console.log(`  retry ${attempt}: ${e.message.slice(0, 100)}`);
        await sleep(2000 * attempt);
      }
    }
    await sleep(300);
  }

  // Upsert tất cả (cả cache cũ + mới) vào Qdrant
  console.log(`→ Upsert ${chunks.length} points vào Qdrant...`);
  const points = chunks.map((c) => ({
    id: hashId(c.code),
    vector: cache[c.code],
    payload: {
      code: c.code,
      source: c.source,
      file: c.file,
      text: c.text,
      charCount: c.charCount,
      ...(c.conversation_id ? { conversation_id: c.conversation_id } : {}),
      ...(c.kind ? { kind: c.kind } : {}),
    },
  }));
  await upsertPoints(points);

  const after = await count();
  console.log(`→ Qdrant sau ingest: ${after} vectors`);
  console.log("✓ Done.");
}

// Qdrant point ID phải là unsigned int hoặc UUID. Code của ta là string.
// → hash thành số 32-bit (giả lập UUID v5-style).
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  // Trả về số dương 32-bit
  return Math.abs(h);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});