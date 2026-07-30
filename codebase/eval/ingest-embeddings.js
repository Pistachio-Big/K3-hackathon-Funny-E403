#!/usr/bin/env node
/**
 * ingest-embeddings.js — Đẩy embeddings.json vào Qdrant
 *
 * Không cần GEMINI_API_KEY vì embeddings đã có sẵn (từ embedder.js)
 *
 * Chạy: node ingest-embeddings.js
 */

const fs = require("fs");
const path = require("path");
require("./loadenv.js");

const { ensureCollection, upsertPoints, count } = require("./qdrant.js");

const CHUNKS = path.resolve(__dirname, "chunks.json");
const EMBEDDINGS = path.resolve(__dirname, "embeddings.json");

function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

async function main() {
  console.log("→ Load chunks và embeddings...");
  const chunks = JSON.parse(fs.readFileSync(CHUNKS, "utf-8"));
  const embeddings = JSON.parse(fs.readFileSync(EMBEDDINGS, "utf-8"));

  // Build lookup map
  const embedMap = new Map();
  for (const e of embeddings) {
    embedMap.set(e.code, e.embedding);
  }

  console.log(`  chunks: ${chunks.length}, embeddings: ${embeddings.length}`);

  // Ensure collection
  await ensureCollection();
  const before = await count();
  console.log(`→ Qdrant collection: ${before} vectors`);

  // Build points
  const points = [];
  let missing = 0;
  for (const c of chunks) {
    const vec = embedMap.get(c.code);
    if (!vec) {
      missing++;
      continue;
    }
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

  if (missing > 0) {
    console.log(`⚠ ${missing} chunks không có embedding, bỏ qua`);
  }

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
