#!/usr/bin/env node
/**
 * qdrant.js — Qdrant REST client (no deps) + index/search helpers
 *
 * Không dùng npm package — gọi REST API trực tiếp (Qdrant HTTP 6333).
 * Phù hợp cho prototype hackathon: 2,192 vectors, không cần client lib.
 *
 * Cấu hình (env hoặc .env):
 *   QDRANT_URL=http://localhost:6333
 *   QDRANT_API_KEY=  (optional — Qdrant Cloud)
 *   QDRANT_COLLECTION=vlearn_tutor
 *   VECTOR_DIM=768
 *
 * API:
 *   await ensureCollection()       // tạo collection nếu chưa có
 *   await upsertPoints(points)     // points = [{id, vector, payload}, ...]
 *   await search(vector, topK=5)   // [{id, score, payload}, ...]
 *   await count()                  // số vector hiện có
 *   await deleteAll()              // reset collection
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
require("./loadenv.js");

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const COLLECTION = process.env.QDRANT_COLLECTION || "vlearn_tutor";
const VECTOR_DIM = parseInt(process.env.VECTOR_DIM || "768", 10);

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(QDRANT_URL + path);
    const mod = u.protocol === "https:" ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: {
        "Content-Type": "application/json",
      },
    };
    if (QDRANT_API_KEY) opts.headers["api-key"] = QDRANT_API_KEY;
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = mod.request(opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Qdrant HTTP ${res.statusCode}: ${buf.slice(0, 300)}`));
        }
        if (!buf) return resolve(null);
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(new Error(`Qdrant JSON parse: ${buf.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function collectionExists() {
  try {
    await call("GET", `/collections/${COLLECTION}`);
    return true;
  } catch (e) {
    if (e.message.includes("HTTP 404")) return false;
    throw e;
  }
}

async function ensureCollection() {
  if (await collectionExists()) {
    return { created: false };
  }
  await call("PUT", `/collections/${COLLECTION}`, {
    vectors: {
      size: VECTOR_DIM,
      distance: "Cosine",
    },
    // Tối ưu cho payload có source/text filter
    optimizers_config: { default_segment_number: 2 },
  });
  return { created: true };
}

async function upsertPoints(points) {
  // Qdrant batch tối đa ~1000 points / lần để tránh timeout
  const BATCH = 256;
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    await call("PUT", `/collections/${COLLECTION}/points`, { points: batch });
  }
  return points.length;
}

async function search(vector, topK = 5) {
  const j = await call("POST", `/collections/${COLLECTION}/points/search`, {
    vector,
    limit: topK,
    with_payload: true,
  });
  return j.result.map((p) => ({
    id: p.id,
    score: p.score,
    payload: p.payload,
  }));
}

async function count() {
  const j = await call("GET", `/collections/${COLLECTION}`);
  return j.result?.vectors_count || 0;
}

async function deleteAll() {
  await call("DELETE", `/collections/${COLLECTION}/points`);
  return { reset: true };
}

async function health() {
  try {
    await call("GET", "/healthz");
    return { ok: true };
  } catch (e) {
    const msg = e?.message || String(e) || "unknown error";
    return { ok: false, error: msg };
  }
}

module.exports = {
  COLLECTION,
  VECTOR_DIM,
  ensureCollection,
  upsertPoints,
  search,
  count,
  deleteAll,
  health,
};

// CLI
if (require.main === module) {
  const cmd = process.argv[2] || "health";
  (async () => {
    if (cmd === "health") {
      const h = await health();
      console.log("Health:", h);
      const c = await collectionExists();
      console.log(`Collection '${COLLECTION}':`, c ? "exists" : "missing");
      if (c) {
        const n = await count();
        console.log(`Vector count: ${n}`);
      }
    } else if (cmd === "create") {
      const r = await ensureCollection();
      console.log("Ensure:", r);
    } else if (cmd === "reset") {
      await deleteAll();
      console.log("Reset done");
    } else {
      console.log("Usage: qdrant.js [health|create|reset]");
    }
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}