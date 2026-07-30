#!/usr/bin/env node
/**
 * benchmark.js — Chạy golden set qua askTutor, lưu kết quả CSV
 *
 * Cách dùng:
 *   1. Tạo eval/golden-set.jsonl (mỗi dòng 1 test case)
 *   2. Chạy:  node codebase/eval/benchmark.js
 *   3. Kết quả: eval/run-N.csv (id, layer, question, mode, citations, isFailure, failSafe)
 *
 * Format golden-set.jsonl:
 *   {"id":"case-001","layer":"①","question":"...","expected_codes":["T01-001"]}
 *
 * Layer (taxonomy 4 lớp):
 *   ① Nguồn sự thật  — AI có bịa mã đoạn không?
 *   ② Mơ hồ          — input không đủ thông tin
 *   ③ Ngoài phạm vi   — user hỏi thứ không được phép
 *   ④ Đặc thù domain  — sai kiến thức
 */

const fs = require("fs");
const path = require("path");
require("./loadenv.js");

const GOLDEN = path.resolve(__dirname, "golden-set.jsonl");
const OUT_DIR = path.resolve(__dirname);

function findNextRunFile() {
  let i = 1;
  while (fs.existsSync(path.join(OUT_DIR, `run-${i}.csv`))) i++;
  return path.join(OUT_DIR, `run-${i}.csv`);
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main() {
  if (!fs.existsSync(GOLDEN)) {
    console.error(`⚠ Không thấy ${GOLDEN}`);
    console.error(`  Tạo file golden-set.jsonl với format mỗi dòng 1 JSON object:`);
    console.error(`  {"id":"...","layer":"①","question":"...","expected_codes":["T01-001"]}`);
    process.exit(1);
  }

  const { askTutor } = require("./rag.js");

  const lines = fs.readFileSync(GOLDEN, "utf-8").trim().split(/\r?\n/);
  const cases = lines.map((l) => JSON.parse(l));
  console.log(`→ Chạy ${cases.length} test case...\n`);

  const out = findNextRunFile();
  const ws = fs.createWriteStream(out);
  ws.write(
    "id,layer,question,mode,retrieved_top1,retrieved_top1_score,verified_citations,hallucinated_count,isFailure,failSafe,latency_ms\n"
  );

  const summary = { total: 0, byLayer: {}, hallucinated: [], noCitation: [] };

  for (const c of cases) {
    process.stdout.write(`  [${c.id}] ${c.layer} ... `);
    const t0 = Date.now();
    let r;
    try {
      r = await askTutor(c.question);
    } catch (e) {
      console.log(`ERROR: ${e.message.slice(0, 80)}`);
      ws.write(
        [
          csvEscape(c.id),
          csvEscape(c.layer),
          csvEscape(c.question),
          "ERROR",
          "",
          "",
          "",
          "",
          "",
          csvEscape(e.message.slice(0, 200)),
          Date.now() - t0,
        ].join(",") + "\n"
      );
      continue;
    }
    const latency = Date.now() - t0;
    const top1 = r.trace.retrieved[0];
    const verified = (r.citations || []).join("|");
    const halluCount = r.trace.verified?.hallucinated?.length || 0;
    const isFail = r.isFailure ? "yes" : "no";
    const failSafe = r.trace.verified?.failSafe || "";

    ws.write(
      [
        csvEscape(c.id),
        csvEscape(c.layer),
        csvEscape(c.question),
        csvEscape(r.trace.mode),
        csvEscape(top1?.code || ""),
        top1?.score?.toFixed(4) || "",
        csvEscape(verified),
        halluCount,
        isFail,
        csvEscape(failSafe),
        latency,
      ].join(",") + "\n"
    );

    summary.total++;
    summary.byLayer[c.layer] = (summary.byLayer[c.layer] || 0) + 1;
    if (halluCount > 0) summary.hallucinated.push(c.id);
    if (r.isFailure) summary.noCitation.push(c.id);

    console.log(`${r.isFailure ? "FAIL" : "OK"} · cite=${verified || "(none)"} · ${latency}ms`);
  }

  ws.end();
  console.log(`\n→ Đã ghi kết quả: ${out}`);
  console.log(`\n=== Tổng kết ===`);
  console.log(`Tổng: ${summary.total} case`);
  for (const [layer, n] of Object.entries(summary.byLayer)) {
    console.log(`  ${layer}: ${n} case`);
  }
  if (summary.hallucinated.length) {
    console.log(`⚠ ${summary.hallucinated.length} case có hallucination: ${summary.hallucinated.join(", ")}`);
  } else {
    console.log(`✓ 0 case hallucination`);
  }
  console.log(`Failure path: ${summary.noCitation.length}/${summary.total} case`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});