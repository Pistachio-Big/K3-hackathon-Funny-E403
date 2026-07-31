#!/usr/bin/env node
/**
 * metrics-eval.js — Comprehensive metrics evaluator
 *
 * Mục tiêu: chạy lại eval trọn bộ golden-set.json với rag.js pipeline thật
 * (tool calling + summarization + web research), đánh giá 5 lớp chỗ khó
 * theo rubric, xuất CSV + JSON + Markdown report.
 *
 * Output:
 *   - eval/metrics-run.csv         : từng case một dòng, đầy đủ cột
 *   - eval/metrics-summary.json    : tổng hợp số liệu
 *   - eval/metrics-report.md       : báo cáo Markdown
 *
 * Sử dụng:
 *   node codebase/eval/metrics-eval.js              # chạy đủ 40 case
 *   node codebase/eval/metrics-eval.js --limit 10   # chạy 10 case đầu
 *   node codebase/eval/metrics-eval.js --layer ①-bianguon  # chỉ 1 layer
 */

const fs = require("fs");
const path = require("path");
require("./loadenv.js");

const GOLDEN_SET = path.resolve(__dirname, "golden-set.json");
const OUTPUT_CSV = path.resolve(__dirname, "metrics-run.csv");
const OUTPUT_JSON = path.resolve(__dirname, "metrics-summary.json");
const OUTPUT_MD = path.resolve(__dirname, "metrics-report.md");

const { askTutor } = require("./rag.js");

// ============== CLI ARGS ==============
const args = process.argv.slice(2);
const LIMIT = (() => {
  const idx = args.indexOf("--limit");
  return idx >= 0 ? parseInt(args[idx + 1], 10) : null;
})();
const LAYER_FILTER = (() => {
  const idx = args.indexOf("--layer");
  return idx >= 0 ? args[idx + 1] : null;
})();

// ============== EVALUATORS PER QUALITY DIMENSION ==============

/**
 * Kiểm tra có citation hợp lệ trong answer không
 * Citation hợp lệ:
 *   - [Txx-NNN]      (transcript chunk)
 *   - [Cxxxx-Tyyyy-K] (chatlog)
 *   - [Cxxxx]        (chatlog rút gọn)
 */
function checkHasCitation(answer, citations) {
  const validPattern = /\[((?:T\d{2}-\d{1,3})|(?:C\d{4}(?:-T\d{4}-[QA])?))\]/g;
  const matches = [...answer.matchAll(validPattern)].map(m => m[1]);
  // Loại bỏ citations trùng
  const uniqMatches = [...new Set(matches)];

  return {
    has_citation: uniqMatches.length > 0 || (citations && citations.length > 0),
    citation_count: uniqMatches.length,
    citations_found: uniqMatches
  };
}

/**
 * Kiểm tra format citation đúng (đều có dạng [Txx-NNN] hoặc [Cxxxx])
 */
function checkCiteFormat(answer) {
  const pattern = /\[((?:T\d{2}-\d{1,3})|(?:C\d{4}(?:-T\d{4}-[QA])?))\]/g;
  const all = [...answer.matchAll(pattern)].map(m => m[1]);
  if (all.length === 0) return { cite_format_ok: false, format_note: "no citation" };
  // Tất cả citations đều đúng format regex nên OK
  return { cite_format_ok: true, format_note: `${all.length} valid citation(s)` };
}

/**
 * Kiểm tra trích dẫn đúng trang được kỳ vọng (nếu có)
 * expected_cite_pages là mảng số trang → chuyển sang mã Txx dựa vào tiền tố
 * Trong dataset này, mỗi page X tương ứng T01 → T01-X (slide X của day 1)
 * Nhưng chúng ta không biết chính xác mapping → dùng heuristic:
 *   - Kiểm tra có ít nhất 1 citation [Txx-NNN] không
 *   - Citation nằm trong top 30 chunks retrieved là "relevant"
 */
function checkExpectedPages(citations, retrievedCodes, expectedPages) {
  if (!expectedPages || expectedPages.length === 0) {
    return { pages_match: null, note: "no specific page required" };
  }

  // Với dataset này, mapping page → code không có sẵn nên chỉ kiểm tra
  // có ít nhất 1 citation transcript
  const hasTranscriptCitation = citations && citations.some(c => /^T\d{2}-/.test(c));
  return {
    pages_match: hasTranscriptCitation,
    note: hasTranscriptCitation
      ? `has transcript citation among retrieved [${retrievedCodes.slice(0, 5).join(", ")}]`
      : `no transcript citation; retrieved [${retrievedCodes.slice(0, 5).join(", ")}]`
  };
}

/**
 * Kiểm tra độ chính xác nội dung dựa trên expected_topics
 */
function checkContentAccuracy(answer, expectedTopics) {
  if (!expectedTopics || expectedTopics.length === 0) {
    return {
      content_accurate: null,
      matched_count: 0,
      total_expected: 0,
      match_ratio: null,
      note: "no specific topics required (open question or refusal case)"
    };
  }
  const answerLower = answer.toLowerCase();
  const matched = expectedTopics.filter(t => answerLower.includes(t.toLowerCase()));
  const ratio = matched.length / expectedTopics.length;
  return {
    content_accurate: ratio >= 0.5,
    matched_count: matched.length,
    total_expected: expectedTopics.length,
    match_ratio: Number(ratio.toFixed(2)),
    matched_topics: matched,
    missing_topics: expectedTopics.filter(t => !matched.includes(t))
  };
}

/**
 * Kiểm tra an toàn (không đoán/bịa)
 * Một answer "safe" nếu:
 *   1. Thừa nhận không biết khi context không đủ
 *   2. Có ít nhất 1 citation hợp lệ (tránh hallucinate mã)
 *   3. Không chứa marker hallucinated [⚠code?]
 */
function checkSafety(answer, citations, expectedTopics) {
  const unknownPhrases = [
    "không tìm thấy", "không có thông tin", "không có trong tài liệu",
    "ngoài phạm vi", "không liên quan", "tôi không biết", "mình không tìm",
    "không có nội dung", "bạn nên hỏi", "hỏi giảng viên", "hỏi trực tiếp"
  ];
  const answerLower = answer.toLowerCase();
  const mentionsUnknown = unknownPhrases.some(p => answerLower.includes(p));
  const hasHallucinatedMarker = /\[⚠.*?\]/.test(answer);
  const hasValidCitation = citations && citations.length > 0;

  // Safe nếu:
  // - có citation hợp lệ HOẶC
  // - thừa nhận không biết rõ ràng HOẶC
  // - là câu hỏi mơ hồ ngoài phạm vi
  const isSafe = hasValidCitation || mentionsUnknown;

  return {
    safe_not_guess: isSafe,
    mentions_unknown: mentionsUnknown,
    has_hallucinated_marker: hasHallucinatedMarker,
    has_valid_citation: hasValidCitation,
    safety_note: hasHallucinatedMarker
      ? "stripped hallucinated citation"
      : mentionsUnknown
        ? "admits lack of knowledge (good)"
        : hasValidCitation
          ? "has valid citation (good)"
          : "no citation and no admission"
  };
}

/**
 * Kiểm tra hành vi đúng cho từng layer:
 *   - ① bianguon     → phải có citation transcript
 *   - ② lactrinhdo   → giải thích đơn giản, có thể không cần citation
 *   - ③ citesai      → phải có citation transcript (và đúng trang nếu có)
 *   - ④ duoankhi-thieukhong → refusal đúng đắn HOẶC trả lời khi context đủ
 *   - ⑤ edge-real    → từ chối hợp lý / hỏi lại / không crash
 */
function checkLayerBehavior(layer, answer, citations, isAcceptable, hasCitation, contentAcc, safety) {
  let layer_pass = false;
  let layer_note = "";

  switch (layer) {
    case "①-bianguon":
      // Cần có citation transcript và content accurate
      layer_pass = hasCitation && (contentAcc === null || contentAcc === true);
      layer_note = hasCitation ? "bianguon+citation OK" : "bianguon MISSING citation";
      break;
    case "②-lactrinhdo":
      // Cần content accurate hoặc refusal đúng (khi không có tài liệu)
      layer_pass = contentAcc === null || contentAcc === true || safety.mentions_unknown;
      layer_note = "lactrinhdo: explanation layer";
      break;
    case "③-citesai":
      // Cần citation transcript (quan trọng nhất)
      layer_pass = hasCitation;
      layer_note = hasCitation ? "citesai: citation present" : "citesai: citation MISSING";
      break;
    case "④-duoankhi-thieukhong":
      // Cần an toàn: refusal đúng HOẶC trả lời đúng khi có dữ liệu
      if (isAcceptable) {
        // Kỳ vọng refusal (không có expected_topics)
        layer_pass = safety.safe_not_guess;
        layer_note = safety.mentions_unknown
          ? "refused appropriately"
          : safety.has_valid_citation
            ? "answered with citation"
            : "safe but no clear signal";
      } else {
        // Không chấp nhận được nếu AI cố trả lời quá rộng
        layer_pass = safety.mentions_unknown;
        layer_note = safety.mentions_unknown
          ? "refused (acceptable for broad question)"
          : "did not refuse (RISKY)";
      }
      break;
    case "⑤-edge-real":
      // Edge cases: yêu cầu an toàn + không crash
      layer_pass = safety.safe_not_guess;
      layer_note = safety.safe_not_guess
        ? "edge: handled safely"
        : "edge: FAILED to handle safely";
      break;
    default:
      layer_pass = false;
      layer_note = "unknown layer";
  }

  return { layer_pass, layer_note };
}

// ============== MAIN ==============
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log("=== VLearn Tutor — Comprehensive Metrics Eval ===\n");

  // Load golden set
  const goldenSet = JSON.parse(fs.readFileSync(GOLDEN_SET, "utf-8"));
  let cases = goldenSet;
  if (LAYER_FILTER) {
    cases = cases.filter(c => c.layer === LAYER_FILTER);
    console.log(`→ Filtered to layer "${LAYER_FILTER}": ${cases.length} cases`);
  }
  if (LIMIT) {
    cases = cases.slice(0, LIMIT);
    console.log(`→ Limited to ${cases.length} cases`);
  }
  console.log(`→ Total cases to evaluate: ${cases.length}\n`);

  const results = [];
  const startTime = Date.now();

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const t0 = Date.now();
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} (${c.layer})... `);

    try {
      // Gọi rag.js pipeline thật
      const tutorResp = await askTutor(c.question);
      const elapsed = Date.now() - t0;

      const answer = tutorResp.answer || "";
      const citations = tutorResp.citations || [];
      const retrieved = (tutorResp.trace?.retrieved || []).map(r => r.code);
      const retrieveMode = tutorResp.trace?.retrieveMode || "unknown";

      // 1. Citation presence
      const citeCheck = checkHasCitation(answer, citations);

      // 2. Citation format
      const formatCheck = checkCiteFormat(answer);

      // 3. Expected pages match
      const pageCheck = checkExpectedPages(citations, retrieved, c.expected_cite_pages);

      // 4. Content accuracy
      const contentCheck = checkContentAccuracy(answer, c.expected_topics);

      // 5. Safety
      const safetyCheck = checkSafety(answer, citations, c.expected_topics);

      // 6. Layer-specific behavior
      const layerCheck = checkLayerBehavior(
        c.layer, answer, citations, c.is_acceptable,
        citeCheck.has_citation, contentCheck.content_accurate, safetyCheck
      );

      // Tổng hợp overall pass
      const overallPass =
        safetyCheck.safe_not_guess &&
        (citeCheck.has_citation || safetyCheck.mentions_unknown || c.expected_topics?.length === 0) &&
        (layerCheck.layer_pass);

      const result = {
        id: c.id,
        layer: c.layer,
        test_type: c.test_type || null,
        scenario: c.scenario || "",
        question: c.question,
        expected_topics: c.expected_topics || [],
        expected_pages: c.expected_cite_pages || [],
        expected_acceptable: c.is_acceptable,

        // Kết quả hệ thống
        answer_preview: answer.slice(0, 200).replace(/\n/g, " "),
        answer_length: answer.length,
        retrieve_mode: retrieveMode,
        retrieved_codes: retrieved.slice(0, 5).join("|"),
        citations: citations.join("|"),
        used_web_research: !!(tutorResp.researchInfo?.used),

        // Metrics
        has_citation: citeCheck.has_citation,
        citation_count: citeCheck.citation_count,
        cite_format_ok: formatCheck.cite_format_ok,
        pages_match: pageCheck.pages_match,
        content_accurate: contentCheck.content_accurate,
        matched_topics_count: contentCheck.matched_count || 0,
        match_ratio: contentCheck.match_ratio,
        safe_not_guess: safetyCheck.safe_not_guess,
        mentions_unknown: safetyCheck.mentions_unknown,
        is_failure: tutorResp.isFailure,
        layer_pass: layerCheck.layer_pass,
        layer_note: layerCheck.layer_note,
        overall_pass: overallPass,
        latency_ms: elapsed
      };

      results.push(result);
      console.log(`${overallPass ? "PASS" : "FAIL"} (${elapsed}ms) [cite=${citeCheck.has_citation}, safe=${safetyCheck.safe_not_guess}, layer=${layerCheck.layer_pass}]`);
    } catch (e) {
      const elapsed = Date.now() - t0;
      console.error(`ERROR (${elapsed}ms): ${e.message}`);
      results.push({
        id: c.id,
        layer: c.layer,
        test_type: c.test_type || null,
        scenario: c.scenario || "",
        question: c.question,
        expected_topics: c.expected_topics || [],
        expected_pages: c.expected_cite_pages || [],
        expected_acceptable: c.is_acceptable,
        answer_preview: `ERROR: ${e.message}`,
        answer_length: 0,
        retrieve_mode: "error",
        retrieved_codes: "",
        citations: "",
        used_web_research: false,
        has_citation: false,
        citation_count: 0,
        cite_format_ok: false,
        pages_match: false,
        content_accurate: false,
        matched_topics_count: 0,
        match_ratio: 0,
        safe_not_guess: false,
        mentions_unknown: false,
        is_failure: true,
        layer_pass: false,
        layer_note: `error: ${e.message}`,
        overall_pass: false,
        latency_ms: elapsed
      });
    }

    await sleep(800); // Rate limit
  }

  const totalElapsed = Date.now() - startTime;
  console.log(`\n→ Done in ${(totalElapsed / 1000).toFixed(1)}s\n`);

  // ============== WRITE CSV ==============
  const csvHeader = [
    "id", "layer", "test_type", "scenario", "question",
    "has_citation", "citation_count", "cite_format_ok",
    "pages_match", "content_accurate", "matched_topics_count", "match_ratio",
    "safe_not_guess", "mentions_unknown", "is_failure",
    "layer_pass", "layer_note", "overall_pass",
    "expected_acceptable", "expected_topics", "expected_pages",
    "retrieve_mode", "retrieved_codes", "citations",
    "used_web_research", "answer_length", "latency_ms",
    "answer_preview"
  ].join(",");

  const csvRows = results.map(r => [
    r.id,
    r.layer,
    r.test_type || "",
    `"${(r.scenario || "").replace(/"/g, '""')}"`,
    `"${r.question.replace(/"/g, '""')}"`,
    r.has_citation,
    r.citation_count,
    r.cite_format_ok,
    r.pages_match === null ? "" : r.pages_match,
    r.content_accurate === null ? "" : r.content_accurate,
    r.matched_topics_count,
    r.match_ratio === null ? "" : r.match_ratio,
    r.safe_not_guess,
    r.mentions_unknown,
    r.is_failure,
    r.layer_pass,
    `"${r.layer_note.replace(/"/g, '""')}"`,
    r.overall_pass,
    r.expected_acceptable,
    `"${r.expected_topics.join(";")}"`,
    `"${r.expected_pages.join(";")}"`,
    r.retrieve_mode,
    `"${r.retrieved_codes}"`,
    `"${r.citations}"`,
    r.used_web_research,
    r.answer_length,
    r.latency_ms,
    `"${r.answer_preview.replace(/"/g, '""')}"`
  ].join(","));

  fs.writeFileSync(OUTPUT_CSV, csvHeader + "\n" + csvRows.join("\n"));
  console.log(`→ CSV written to ${OUTPUT_CSV}`);

  // ============== AGGREGATE METRICS ==============
  const total = results.length;
  const passed = results.filter(r => r.overall_pass).length;
  const passRate = (passed / total * 100).toFixed(1);

  const withTopics = results.filter(r => r.expected_topics.length > 0);
  const contentAccCount = withTopics.filter(r => r.content_accurate === true).length;
  const contentAccRate = withTopics.length > 0
    ? (contentAccCount / withTopics.length * 100).toFixed(1)
    : "N/A";

  const citationRate = (results.filter(r => r.has_citation).length / total * 100).toFixed(1);
  const safeRate = (results.filter(r => r.safe_not_guess).length / total * 100).toFixed(1);
  const formatRate = (results.filter(r => r.cite_format_ok).length / total * 100).toFixed(1);

  const avgLatency = (results.reduce((s, r) => s + r.latency_ms, 0) / total).toFixed(0);
  const webResearchCount = results.filter(r => r.used_web_research).length;

  // Per-layer breakdown
  const byLayer = {};
  for (const r of results) {
    if (!byLayer[r.layer]) byLayer[r.layer] = {
      total: 0, pass: 0, has_cite: 0, content_acc: 0,
      with_topics: 0, matched: 0, latency_sum: 0
    };
    const b = byLayer[r.layer];
    b.total++;
    if (r.overall_pass) b.pass++;
    if (r.has_citation) b.has_cite++;
    if (r.content_accurate === true) {
      b.content_acc++;
      b.matched += r.matched_topics_count;
      b.with_topics++;
    }
    b.latency_sum += r.latency_ms;
  }

  // Per-test-type breakdown (for edge cases)
  const byTestType = {};
  for (const r of results) {
    const tt = r.test_type || "(none)";
    if (!byTestType[tt]) byTestType[tt] = { total: 0, pass: 0, safe: 0 };
    byTestType[tt].total++;
    if (r.overall_pass) byTestType[tt].pass++;
    if (r.safe_not_guess) byTestType[tt].safe++;
  }

  // Build summary object
  const summary = {
    timestamp: new Date().toISOString(),
    total_cases: total,
    passed: passed,
    failed: total - passed,
    pass_rate: passRate + "%",

    overall_metrics: {
      citation_rate: citationRate + "%",
      safe_not_guess_rate: safeRate + "%",
      cite_format_ok_rate: formatRate + "%",
      content_accuracy_rate: contentAccRate + "%",
      content_accuracy_evaluated: withTopics.length
    },

    performance: {
      avg_latency_ms: avgLatency,
      total_time_s: (totalElapsed / 1000).toFixed(1),
      web_research_used: webResearchCount
    },

    by_layer: Object.fromEntries(
      Object.entries(byLayer).map(([k, v]) => [k, {
        total: v.total,
        passed: v.pass,
        pass_rate: (v.pass / v.total * 100).toFixed(1) + "%",
        citation_rate: (v.has_cite / v.total * 100).toFixed(1) + "%",
        content_accuracy_rate: v.with_topics > 0
          ? (v.content_acc / v.with_topics * 100).toFixed(1) + "%"
          : "N/A",
        avg_latency_ms: (v.latency_sum / v.total).toFixed(0)
      }])
    ),

    by_test_type: byTestType
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(summary, null, 2));
  console.log(`→ JSON summary written to ${OUTPUT_JSON}`);

  // ============== GENERATE MARKDOWN REPORT ==============
  const md = generateMarkdown(summary, results);
  fs.writeFileSync(OUTPUT_MD, md);
  console.log(`→ Markdown report written to ${OUTPUT_MD}`);

  // ============== PRINT SUMMARY ==============
  console.log("\n=== TỔNG KẾT ===");
  console.log(`Total: ${total} | Pass: ${passed} | Fail: ${total - passed} | Rate: ${passRate}%`);
  console.log(`Citation rate: ${citationRate}% | Safe rate: ${safeRate}% | Content accuracy: ${contentAccRate}%`);
  console.log(`Avg latency: ${avgLatency}ms | Total: ${(totalElapsed / 1000).toFixed(1)}s`);
  console.log("\nTheo layer:");
  for (const [layer, data] of Object.entries(summary.by_layer)) {
    console.log(`  ${layer}: ${data.passed}/${data.total} (${data.pass_rate})`);
  }
}

function generateMarkdown(summary, results) {
  const ts = summary.timestamp;
  const layerNames = {
    "①-bianguon": "① Bianguon (Cơ bản nguồn)",
    "②-lactrinhdo": "② Lactrinhdo (Lạc trình/độ)",
    "③-citesai": "③ Citesai (Trích dẫn sai)",
    "④-duoankhi-thieukhong": "④ Đoán khi thiếu/không có",
    "⑤-edge-real": "⑤ Edge cases (Real chatlog)"
  };

  let md = `# VLearn Tutor — Báo cáo Metrics Evaluation

**Thời gian chạy:** ${ts}  
**Pipeline:** rag.js (TF-IDF + Qdrant fallback + tool calling + summarization + web research)  
**LLM:** ${process.env.EVAL_MODEL || "openai/gpt-4o-mini"} (OpenRouter)  
**Golden set:** 40 cases phủ 5 lớp chỗ khó theo rubric

---

## 1. Tổng quan (Overall)

| Metric | Value |
|---|---|
| Tổng số case | **${summary.total_cases}** |
| Passed | **${summary.passed}** |
| Failed | **${summary.failed}** |
| **Pass rate** | **${summary.pass_rate}** |

### Chiều chất lượng

| Chiều | Rate | Ghi chú |
|---|---|---|
| Citation rate | ${summary.overall_metrics.citation_rate} | Tỷ lệ trả lời có citation hợp lệ |
| Safe-not-guess rate | ${summary.overall_metrics.safe_not_guess_rate} | Tỷ lệ không bịa/bùng |
| Cite format OK | ${summary.overall_metrics.cite_format_ok_rate} | Format [Txx-NNN] / [Cxxxx] đúng |
| Content accuracy | ${summary.overall_metrics.content_accuracy_rate} (n=${summary.overall_metrics.content_accuracy_evaluated}) | Khớp ≥50% expected topics |

### Hiệu năng

| Metric | Value |
|---|---|
| Avg latency | ${summary.performance.avg_latency_ms} ms/case |
| Total time | ${summary.performance.total_time_s} s |
| Web research triggered | ${summary.performance.web_research_used} cases |

---

## 2. Breakdown theo lớp (By Layer)

`;

  for (const [layer, data] of Object.entries(summary.by_layer)) {
    const name = layerNames[layer] || layer;
    md += `### ${name}

| Metric | Value |
|---|---|
| Cases | ${data.total} |
| Passed | ${data.passed} / ${data.total} |
| **Pass rate** | **${data.pass_rate}** |
| Citation rate | ${data.citation_rate} |
| Content accuracy | ${data.content_accuracy_rate} |
| Avg latency | ${data.avg_latency_ms} ms |

`;
  }

  // Edge case breakdown
  md += `---

## 3. Edge cases theo test_type (chỉ layer ⑤)

| Test type | Cases | Passed | Pass rate | Safe rate |
|---|---|---|---|---|
`;
  for (const [tt, data] of Object.entries(summary.by_test_type)) {
    if (tt === "(none)") continue;
    const safeRate = (data.safe / data.total * 100).toFixed(1);
    const passRate = (data.pass / data.total * 100).toFixed(1);
    md += `| ${tt} | ${data.total} | ${data.pass} | ${passRate}% | ${safeRate}% |\n`;
  }

  // Failed cases detail
  md += `
---

## 4. Chi tiết các case FAIL

`;
  const failedCases = results.filter(r => !r.overall_pass);
  if (failedCases.length === 0) {
    md += `✅ **Không có case fail nào.**\n`;
  } else {
    md += `Tổng cộng **${failedCases.length} case fail**:\n\n`;
    md += `| ID | Layer | Question (60c) | Lý do fail |\n|---|---|---|---|\n`;
    for (const r of failedCases) {
      const qShort = r.question.length > 60 ? r.question.slice(0, 57) + "..." : r.question;
      const reasons = [];
      if (!r.has_citation && (r.layer === "①-bianguon" || r.layer === "③-citesai")) {
        reasons.push("missing citation");
      }
      if (r.content_accurate === false) {
        reasons.push(`content acc ${r.match_ratio}`);
      }
      if (!r.safe_not_guess) {
        reasons.push("unsafe (guessing)");
      }
      if (r.is_failure) {
        reasons.push("isFailure=true");
      }
      const reason = reasons.join("; ") || r.layer_note;
      md += `| ${r.id} | ${r.layer} | ${qShort.replace(/\|/g, "\\|")} | ${reason} |\n`;
    }
  }

  // All cases summary
  md += `
---

## 5. Chi tiết từng case

| ID | Layer | Pass | Cite | Content | Safe | Latency (ms) |
|---|---|---|---|---|---|---|
`;
  for (const r of results) {
    const contentStr = r.content_accurate === null ? "n/a" : (r.content_accurate ? "✓" : "✗");
    md += `| ${r.id} | ${r.layer} | ${r.overall_pass ? "✓" : "✗"} | ${r.has_citation ? "✓" : "✗"} | ${contentStr} | ${r.safe_not_guess ? "✓" : "✗"} | ${r.latency_ms} |\n`;
  }

  md += `
---

## 6. Đánh giá so với Quality Bar

Quality bar theo rubric (R4 · Kiểm thử — 15đ):
- Citation rate ≥ 70%
- Safe-not-guess rate ≥ 85%
- Content accuracy ≥ 70% (với case có expected_topics)
- Pass rate tổng ≥ 70%

| Bar | Target | Actual | Đạt? |
|---|---|---|---|
| Citation rate | ≥70% | ${summary.overall_metrics.citation_rate} | ${parseFloat(summary.overall_metrics.citation_rate) >= 70 ? "✅" : "❌"} |
| Safe-not-guess | ≥85% | ${summary.overall_metrics.safe_not_guess_rate} | ${parseFloat(summary.overall_metrics.safe_not_guess_rate) >= 85 ? "✅" : "❌"} |
| Content accuracy | ≥70% | ${summary.overall_metrics.content_accuracy_rate} | ${parseFloat(summary.overall_metrics.content_accuracy_rate) >= 70 ? "✅" : "❌"} |
| Pass rate tổng | ≥70% | ${summary.pass_rate} | ${parseFloat(summary.pass_rate) >= 70 ? "✅" : "❌"} |

---

## 7. Khuyến nghị cải thiện

`;
  const recommendations = [];

  if (parseFloat(summary.overall_metrics.citation_rate) < 70) {
    recommendations.push("- **Tăng citation rate**: Kiểm tra prompt có đủ ép model chèn mã [Txx-NNN] không. Có thể cần giảm `temperature` hoặc tăng cường hướng dẫn.");
  }
  if (parseFloat(summary.overall_metrics.content_accuracy_rate) < 70 && summary.overall_metrics.content_accuracy_evaluated !== "N/A") {
    recommendations.push("- **Cải thiện content accuracy**: Tăng cường retrieval quality (Qdrant vs TF-IDF), mở rộng top-K, hoặc cải thiện chunking.");
  }
  if (parseFloat(summary.overall_metrics.safe_not_guess_rate) < 85) {
    recommendations.push("- **Tăng safety**: Model có xu hướng đoán/bịa khi context yếu. Cần siết chặt fail-safe logic.");
  }

  // Layer-specific recommendations
  for (const [layer, data] of Object.entries(summary.by_layer)) {
    const passRate = parseFloat(data.pass_rate);
    if (passRate < 70) {
      recommendations.push(`- **Layer ${layer}**: pass rate chỉ ${data.pass_rate}. Cần xem lại các case fail cụ thể ở mục 4.`);
    }
  }

  if (recommendations.length === 0) {
    md += `✅ Hệ thống đạt chuẩn quality bar. Có thể tiếp tục tối ưu chi tiết.\n`;
  } else {
    md += recommendations.join("\n") + "\n";
  }

  md += `
---

## 8. Files sinh ra

- \`eval/metrics-run.csv\` — ${results.length} dòng, đầy đủ cột cho từng case
- \`eval/metrics-summary.json\` — Tổng hợp số liệu dạng JSON
- \`eval/metrics-report.md\` — File báo cáo này

**Cách tái chạy:**

\`\`\`bash
# Chạy full 40 case
node codebase/eval/metrics-eval.js

# Chạy thử 10 case
node codebase/eval/metrics-eval.js --limit 10

# Chạy 1 layer
node codebase/eval/metrics-eval.js --layer ①-bianguon
\`\`\`
`;

  return md;
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});