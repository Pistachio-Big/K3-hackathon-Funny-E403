#!/usr/bin/env node
/**
 * server.js — HTTP server cho VLearn Tutor UI
 *
 * Serve static files (index.html, app.js, rag-browser.js, eval/chunks.json...)
 * Proxy endpoint /api/ask tới Gemini để GIẤU API key khỏi browser.
 *
 * Chạy:  node codebase/server.js
 * Mở:    http://localhost:3000
 *
 * Biến môi trường:
 *   GEMINI_API_KEY (load từ codebase/eval/.env)
 *   PORT (mặc định 3000)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
require("./eval/loadenv.js"); // load GEMINI_API_KEY

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_EMBED = process.env.GEMINI_MODEL_EMBED || "text-embedding-004";
const MODEL_GEN = process.env.GEMINI_MODEL_GEN || "gemini-3-flash";
const DIM = 768;

if (!API_KEY) {
  console.error("⚠ GEMINI_API_KEY chưa set — điền vào codebase/eval/.env hoặc export env.");
  console.error("  Server vẫn chạy để serve UI, nhưng /api/ask sẽ trả lỗi.");
}

const qdrant = require("./eval/qdrant.js");

// ============== MIME ==============
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ============== GEMINI CLIENT ==============
function callGemini(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const fullUrl = new URL(
      `https://generativelanguage.googleapis.com/v1beta/${path}?key=${encodeURIComponent(API_KEY)}`
    );
    const req = http.request(
      {
        method,
        hostname: fullUrl.hostname,
        path: fullUrl.pathname + fullUrl.search,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let buffer = "";
        res.on("data", (c) => (buffer += c));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${buffer.slice(0, 300)}`));
          try {
            resolve(JSON.parse(buffer));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ============== STATIC FILE ==============
function serveStatic(req, res) {
  let pathname = decodeURIComponent(url.parse(req.url).pathname);
  if (pathname === "/") pathname = "/index.html";

  // Chặn truy cập .env và data pack
  if (pathname.includes(".env") || pathname.includes("/data/")) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
  fs.createReadStream(filePath).pipe(res);
}

// ============== /api/retrieve ==============
// Proxy retrieve() trong rag.js — tự dùng Qdrant nếu có, fallback TF-IDF.
async function handleRetrieve(req, res) {
  let body = "";
  for await (const c of req) body += c;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }
  const { question, topK = 5 } = payload;
  if (!question) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Thiếu 'question'" }));
    return;
  }
  const { retrieve } = require("./eval/rag.js");
  try {
    const top = await retrieve(question);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ retrieved: top.slice(0, topK) }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ============== /api/ask ==============
async function handleAsk(req, res) {
  if (!API_KEY) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "GEMINI_API_KEY chưa set — điền vào codebase/eval/.env" }));
    return;
  }
  let body = "";
  for await (const c of req) body += c;
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }
  const { question, top } = payload;
  if (!question || !Array.isArray(top)) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "Thiếu 'question' hoặc 'top' (array of codes)" }));
    return;
  }

  // Gọi trực tiếp rag.js.askTutor — server đã load key từ .env
  const { askTutor } = require("./eval/rag.js");
  try {
    const r = await askTutor(question);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ============== ROUTER ==============
const server = http.createServer(async (req, res) => {
  try {
    const pathname = url.parse(req.url).pathname;
    if (pathname === "/api/ask" && req.method === "POST") {
      await handleAsk(req, res);
      return;
    }
    if (pathname === "/api/retrieve" && req.method === "POST") {
      await handleRetrieve(req, res);
      return;
    }
    if (pathname === "/api/health") {
      const qdHealth = await qdrant.health();
      let qdCount = 0;
      if (qdHealth.ok) {
        try {
          qdCount = await qdrant.count();
        } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          hasKey: !!API_KEY,
          embed: MODEL_EMBED,
          gen: MODEL_GEN,
          qdrant: { ...qdHealth, vectors: qdCount, collection: qdrant.COLLECTION },
        })
      );
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error: " + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n  VLearn Tutor UI:  http://localhost:${PORT}`);
  console.log(`  Health check:     http://localhost:${PORT}/api/health`);
  console.log(`  Gemini mode:      ${API_KEY ? "✓ enabled (key loaded)" : "✗ no key"}`);
  console.log(`  Embed model:      ${MODEL_EMBED}`);
  console.log(`  Gen model:        ${MODEL_GEN}\n`);
});