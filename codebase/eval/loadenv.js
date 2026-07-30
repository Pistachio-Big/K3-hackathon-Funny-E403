#!/usr/bin/env node
/**
 * loadenv.js — Load biến môi trường từ file .env (không cần dotenv)
 *
 * Cách dùng:
 *   node -r ./codebase/eval/loadenv.js codebase/eval/rag.js "Câu hỏi?"
 *   hoặc:
 *   require('./codebase/eval/loadenv.js'); // đầu file khác
 *
 * File tìm:
 *   1. codebase/eval/.env (ưu tiên)
 *   2. .env (project root)
 *
 * Format .env (giống dotenv):
 *   KEY=value
 *   KEY="value with space"
 *   # comment
 */

const fs = require("fs");
const path = require("path");

const CANDIDATES = [
  path.resolve(__dirname, ".env"),
  path.resolve(__dirname, "../../.env"),
];

function parseEnv(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function loadEnv() {
  for (const file of CANDIDATES) {
    if (fs.existsSync(file)) {
      const parsed = parseEnv(fs.readFileSync(file, "utf-8"));
      for (const k in parsed) {
        if (process.env[k] === undefined) process.env[k] = parsed[k];
      }
      return { file, loaded: Object.keys(parsed) };
    }
  }
  return null;
}

const result = loadEnv();
if (result) {
  console.error(`[loadenv] loaded from ${result.file}: ${result.loaded.join(", ")}`);
} else {
  console.error("[loadenv] no .env found — relying on process.env");
}

module.exports = { loadEnv };