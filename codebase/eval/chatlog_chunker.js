#!/usr/bin/env node
/**
 * chatlog_chunker.js — Index chatlog thành "C-questions" và "C-answers"
 *
 * Mỗi turn (student + tutor) tạo 2 chunk:
 *   - Cxxxx-Q: câu hỏi học viên (nếu không trống)
 *   - Cxxxx-A: câu trả lời tutor (nếu không trống)
 *
 * Citation format: [Cxxxx] (mã hội thoại).
 * Lưu ý bảo mật: KHÔNG commit chatlog vào repo. File này đọc trực tiếp từ data/vlearn-pack/.
 *
 * Input:  data/vlearn-pack/chatlog/chat_history_anonymized_for_hackathon.csv
 * Output: codebase/eval/chatlog-chunks.json  [{code, kind, conversation_id, text}, ...]
 *
 * Chạy: node codebase/eval/chatlog_chunker.js
 */

const fs = require("fs");
const path = require("path");

const CSV = path.resolve(__dirname, "../../data/vlearn-pack/chatlog/chat_history_anonymized_for_hackathon.csv");
const OUT = path.resolve(__dirname, "chatlog-chunks.json");

// Parser CSV tối thiểu (không dùng thư viện — file này ổn định, không có nháy phức tạp)
function parseCsv(text) {
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    // CSV đơn giản: chỉ xử lý field có dấu nháy kép bao quanh
    const fields = [];
    let cur = "";
    let inQuote = false;
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (ch === '"') {
        if (inQuote && lines[i][j + 1] === '"') {
          cur += '"';
          j++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === "," && !inQuote) {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    const row = {};
    for (let k = 0; k < header.length; k++) row[header[k]] = fields[k] || "";
    rows.push(row);
  }
  return rows;
}

function cleanContent(s) {
  if (!s) return "";
  return s
    .replace(/\s+/g, " ")
    .replace(/^\(.*?\)\s*/, "") // bỏ "(Trang N, đoạn được chọn: ...)" đầu câu hỏi
    .trim();
}

function main() {
  if (!fs.existsSync(CSV)) {
    console.error(`⚠ Không thấy ${CSV}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(CSV, "utf-8");
  const rows = parseCsv(raw);
  console.log(`→ Đọc ${rows.length} dòng CSV.`);

  // Gom theo turn_id
  const turns = new Map();
  for (const r of rows) {
    if (!turns.has(r.turn_id)) {
      turns.set(r.turn_id, {
        turn_id: r.turn_id,
        conversation_id: r.conversation_id,
        day_code: r.day_code,
        student: "",
        tutor: "",
        rating: r.rating,
      });
    }
    const t = turns.get(r.turn_id);
    if (r.role === "student") t.student = cleanContent(r.content);
    else if (r.role === "tutor") t.tutor = cleanContent(r.content);
  }

  console.log(`→ ${turns.size} turn duy nhất.`);

  // Tạo chunks: Q (câu hỏi) + A (trả lời)
  const chunks = [];
  let skippedEmpty = 0;
  for (const t of turns.values()) {
    const code = t.conversation_id; // dùng conversation_id làm citation code
    if (t.student && t.student.length > 5) {
      chunks.push({
        code,
        kind: "Q",
        conversation_id: t.conversation_id,
        turn_id: t.turn_id,
        text: t.student,
      });
    } else skippedEmpty++;
    if (t.tutor && t.tutor.length > 5) {
      chunks.push({
        code,
        kind: "A",
        conversation_id: t.conversation_id,
        turn_id: t.turn_id,
        text: t.tutor,
        rating: t.rating,
      });
    } else skippedEmpty++;
  }

  // Nén trùng mã: nhiều chunk có cùng code. Trong corpus, mỗi chunk là 1 item
  // → retrieval có thể match câu hỏi / câu trả lời riêng biệt.
  fs.writeFileSync(OUT, JSON.stringify(chunks, null, 2));
  console.log(`→ Đã ghi ${chunks.length} chatlog chunks (bỏ qua ${skippedEmpty} rỗng) vào ${OUT}`);

  // Thống kê
  const byCode = new Map();
  for (const c of chunks) byCode.set(c.code, (byCode.get(c.code) || 0) + 1);
  console.log(`→ ${byCode.size} hội thoại duy nhất được index.`);
}

main();