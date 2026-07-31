#!/usr/bin/env node
/**
 * ingest.js — Embed chunks và đẩy vào Qdrant
 *
 * Đã được cập nhật để dùng Jina embed (đồng bộ với embedder.js).
 * Nếu embeddings.json đã có sẵn thì dùng luôn, không embed lại.
 *
 * Cache format:
 *   { "T01-001": [0.012, -0.034, ...], ... }
 *
 * Biến môi trường:
 *   JINA_API_KEY (bắt buộc nếu embeddings.json chưa có)
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
const EMBEDDINGS = path.resolve(__dirname, "embeddings.json");
const MODEL_EMBED = "jina-embeddings-v3";
const DIM = 1024;
const BATCH = 32;

const apiKey = process.env.JINA_API_KEY;
if (!apiKey) {
  console.error("⚠ JINA_API_KEY chưa set — điền vào codebase/eval/.env");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============== EMBED BATCH (Jina) ==============
function embedBatch(texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL_EMBED,
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
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`embed HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
          }
          try {
            const j = JSON.parse(buf);
            return resolve(j.data.map((d) => d.embedding));
          } catch (e) {
            return reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

async function main() {
  const shouldReset = process.argv.includes("--reset");
  if (shouldReset) {
    console.log("→ --reset: xoá collection trước...");
    try { await deleteAll(); } catch {}
  }

  console.log("→ Load chunks...");
  const chunks = JSON.parse(fs.readFileSync(CHUNKS, "utf-8"));

  // Build embeddings cache: load từ embeddings.json (từ embedder.js)
  let embeddings = {};
  if (fs.existsSync(EMBEDDINGS)) {
    const arr = JSON.parse(fs.readFileSync(EMBEDDINGS, "utf-8"));
    for (const e of arr) embeddings[e.code] = e.embedding;
    console.log(`→ Đã có ${Object.keys(embeddings).length} embeddings trong cache.`);
  }

  // Embed các chunks thiếu
  const missing = chunks.filter((c) => !embeddings[c.code]);
  if (missing.length > 0) {
    console.log(`→ Cần embed ${missing.length} đoạn mới...`);
    let done = 0;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      let attempt = 0;
      while (true) {
        try {
          const vecs = await embedBatch(batch.map((c) => c.text));
          for (let j = 0; j < batch.length; j++) {
            embeddings[batch[j].code] = vecs[j];
          }
          done += batch.length;
          console.log(`  ${done}/${missing.length}`);
          break;
        } catch (e) {
          attempt++;
          if (attempt >= 3) {
            console.error(`✗ Lỗi sau 3 lần: ${e.message}`);
            process.exit(1);
          }
          console.log(`  ! Retry ${attempt}/3: ${e.message.slice(0, 100)}`);
          await sleep(2000 * attempt);
        }
      }
      await sleep(200);
    }
    // Lưu embeddings.json để lần sau dùng lại
    const out = chunks.map((c) => ({ code: c.code, embedding: embeddings[c.code] })).filter((x) => x.embedding);
    fs.writeFileSync(EMBEDDINGS, JSON.stringify(out));
  }

  await ensureCollection();
  const before = await count();
  console.log(`→ Qdrant collection: ${before} vectors trước ingest`);

  // Build points
  const points = [];
  let missingCount = 0;
  for (const c of chunks) {
    const vec = embeddings[c.code];
    if (!vec) { missingCount++; continue; }
    points.push({
      id: hashId(c.code),
      vector: vec,
      payload: {
        code: c.code,
        source: c.source || "",
        file: c.file || "",
        text: c.text,
        charCount: c.charCount || c.text.length,
        ...(c.conversation_id ? { conversation_id: c.conversation_id } : {}),
        ...(c.kind ? { kind: c.kind } : {}),
      },
    });
  }

  if (missingCount > 0) console.log(`⚠ ${missingCount} chunks thiếu embedding, bỏ qua`);

  console.log(`→ Upsert ${points.length} points...`);
  await upsertPoints(points);

  const after = await count();
  console.log(`→ Qdrant sau ingest: ${after} vectors`);
  console.log("✓ Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
