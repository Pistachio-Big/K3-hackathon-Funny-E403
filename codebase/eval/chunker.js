#!/usr/bin/env node
/**
 * chunker.js — Merge corpus: transcript (T01-T06) + chatlog (Cxxxx)
 *
 * Input:
 *   - data/vlearn-pack/transcript/transcript-{01..06}-clean.md
 *   - codebase/eval/chatlog-chunks.json (do chatlog_chunker.js sinh ra)
 * Output:
 *   - codebase/eval/chunks.json  [{code, source, file, text, charCount}, ...]
 *
 * Code format:
 *   - Transcript: "T01-001" .. "T06-162"
 *   - Chatlog:    "C0001-Q", "C0001-A" (per-turn; nhiều chunk cùng conversation_id)
 *
 * Chạy: node codebase/eval/chunker.js
 */

const fs = require("fs");
const path = require("path");

const TRANSCRIPT_DIR = path.resolve(__dirname, "../../data/vlearn-pack/transcript");
const CHATLOG = path.resolve(__dirname, "chatlog-chunks.json");
const OUT = path.resolve(__dirname, "chunks.json");

const FILES = [
  "transcript-01-clean.md",
  "transcript-02-clean.md",
  "transcript-03-clean.md",
  "transcript-04-clean.md",
  "transcript-05-clean.md",
  "transcript-06-clean.md",
];

const RE_CHUNK_START = /^\*\*\[(T\d{2}-\d{1,3})\]\*\*\s*(.*)$/;

function chunkTranscript(filePath, fileName) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const chunks = [];
  let cur = null;

  for (const line of lines) {
    const m = line.match(RE_CHUNK_START);
    if (m) {
      if (cur) chunks.push(cur);
      cur = { code: m[1], source: "transcript", file: fileName, text: m[2].trim() };
    } else if (cur) {
      const t = line.trim();
      if (!t) continue;
      if (t.startsWith("#")) continue;
      if (t.startsWith(">")) continue;
      cur.text += " " + t;
    }
  }
  if (cur) chunks.push(cur);

  return chunks
    .map((c) => ({
      code: c.code,
      source: "transcript",
      file: c.file,
      text: c.text.replace(/\s+/g, " ").trim(),
      charCount: c.text.length,
    }))
    .filter((c) => c.text.length > 0);
}

function loadChatlog() {
  if (!fs.existsSync(CHATLOG)) {
    console.error(`⚠ Không thấy ${CHATLOG} — chạy chatlog_chunker.js trước.`);
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(CHATLOG, "utf-8"));
  return raw.map((c) => ({
    // code = Cxxxx-Tyyyy-Q/A (conversation × turn × kind) để unique
    code: `${c.conversation_id}-${c.turn_id}-${c.kind}`,
    source: "chatlog",
    file: "chat_history_anonymized_for_hackathon.csv",
    conversation_id: c.conversation_id,
    turn_id: c.turn_id,
    kind: c.kind,
    text: c.text,
    charCount: c.text.length,
  }));
}

function main() {
  const all = [];

  // 1. Transcript
  let transcriptCount = 0;
  for (const f of FILES) {
    const full = path.join(TRANSCRIPT_DIR, f);
    if (!fs.existsSync(full)) {
      console.error(`⚠ Không tìm thấy: ${full}`);
      continue;
    }
    const chunks = chunkTranscript(full, f);
    console.log(`✓ ${f}: ${chunks.length} đoạn`);
    all.push(...chunks);
    transcriptCount += chunks.length;
  }

  // 2. Chatlog
  const chatlogChunks = loadChatlog();
  console.log(`✓ chatlog: ${chatlogChunks.length} chunk (Q + A)`);
  all.push(...chatlogChunks);

  // Kiểm tra trùng mã
  const seen = new Map();
  for (const c of all) {
    if (seen.has(c.code)) {
      console.error(`⚠ MÃ TRÙNG: ${c.code} (file: ${c.file})`);
    } else {
      seen.set(c.code, c.file);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
  console.log(
    `\n→ Tổng: ${all.length} chunks (transcript ${transcriptCount} + chatlog ${chatlogChunks.length})`
  );
  console.log(`→ Đã ghi vào ${OUT}`);
}

main();