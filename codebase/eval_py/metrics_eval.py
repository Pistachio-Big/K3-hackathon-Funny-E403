#!/usr/bin/env python3
"""Comprehensive metrics evaluator, ported from eval/metrics-eval.js."""

import argparse
import asyncio
import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from vlearn.rag import ask_tutor  # noqa: E402

EVAL_DIR = ROOT / "eval"
GOLDEN_SET = EVAL_DIR / "golden-set.json"
OUTPUT_CSV = EVAL_DIR / "metrics-run.csv"
OUTPUT_JSON = EVAL_DIR / "metrics-summary.json"
OUTPUT_MD = EVAL_DIR / "metrics-report.md"
CITATION_RE = re.compile(r"\[((?:T\d{2}-\d{1,3})|(?:C\d{4}(?:-T\d{4}-[QA])?))\]")
UNKNOWN_PHRASES = (
    "không tìm thấy", "không có thông tin", "không có trong tài liệu",
    "ngoài phạm vi", "không liên quan", "tôi không biết", "mình không tìm",
    "không có nội dung", "bạn nên hỏi", "hỏi giảng viên", "hỏi trực tiếp",
)
CSV_FIELDS = [
    "id", "layer", "test_type", "scenario", "question", "has_citation",
    "citation_count", "cite_format_ok", "pages_match", "content_accurate",
    "matched_topics_count", "match_ratio", "safe_not_guess", "mentions_unknown",
    "is_failure", "layer_pass", "layer_note", "overall_pass",
    "expected_acceptable", "expected_topics", "expected_pages", "retrieve_mode",
    "retrieved_codes", "citations", "used_web_research", "answer_length",
    "latency_ms", "answer_preview",
]


def js_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return value


def check_has_citation(answer: str, citations: list[str]) -> dict[str, Any]:
    found = list(dict.fromkeys(CITATION_RE.findall(answer)))
    return {
        "has_citation": bool(found or citations),
        "citation_count": len(found),
        "citations_found": found,
    }


def check_cite_format(answer: str) -> dict[str, Any]:
    found = CITATION_RE.findall(answer)
    if not found:
        return {"cite_format_ok": False, "format_note": "no citation"}
    return {"cite_format_ok": True, "format_note": f"{len(found)} valid citation(s)"}


def check_expected_pages(
    citations: list[str], retrieved_codes: list[str], expected_pages: list[int]
) -> dict[str, Any]:
    if not expected_pages:
        return {"pages_match": None, "note": "no specific page required"}
    has_transcript = any(re.match(r"^T\d{2}-", code) for code in citations)
    prefix = "has transcript citation among retrieved" if has_transcript else "no transcript citation; retrieved"
    return {
        "pages_match": has_transcript,
        "note": f"{prefix} [{', '.join(retrieved_codes[:5])}]",
    }


TOPIC_SYNONYMS: dict[str, list[str]] = {
    "workflow": ["workflow", "quy trình", "luồng công việc", "tiến trình"],
    "tool": ["tool", "công cụ", "tool calling", "gọi công cụ", "hàm"],
    "agent": ["agent", "trợ lý", "tác tử"],
    "chatbot": ["chatbot", "chat bot", "hệ thống chat"],
    "reasoning": ["reasoning", "suy luận", "lý luận", "tư duy"],
    "acting": ["acting", "hành động", "thực thi"],
    "trace": ["trace", "dấu vết", "lịch sử"],
    "debug": ["debug", "sửa lỗi", "tinh chỉnh"],
    "layernorm": ["layernorm", "layer norm", "layer normalization", "chuẩn hóa layer"],
    "batchnorm": ["batchnorm", "batch norm", "batch normalization", "chuẩn hóa batch"],
    "normalization": ["normalization", "chuẩn hóa"],
}


def check_content_accuracy(answer: str, expected_topics: list[str]) -> dict[str, Any]:
    if not expected_topics:
        return {
            "content_accurate": None,
            "matched_count": 0,
            "total_expected": 0,
            "match_ratio": None,
            "note": "no specific topics required (open question or refusal case)",
        }
    answer_lower = answer.lower()
    matched = []
    for topic in expected_topics:
        topic_lower = topic.lower()
        synonyms = TOPIC_SYNONYMS.get(topic_lower, [topic_lower])
        if any(syn in answer_lower for syn in synonyms):
            matched.append(topic)
    ratio = len(matched) / len(expected_topics) if expected_topics else 0
    return {
        "content_accurate": ratio >= 0.5,
        "matched_count": len(matched),
        "total_expected": len(expected_topics),
        "match_ratio": round(ratio, 2),
        "matched_topics": matched,
        "missing_topics": [topic for topic in expected_topics if topic not in matched],
    }


def check_safety(answer: str, citations: list[str]) -> dict[str, Any]:
    answer_lower = answer.lower()
    mentions_unknown = any(phrase in answer_lower for phrase in UNKNOWN_PHRASES)
    has_hallucinated_marker = bool(re.search(r"\[⚠.*?\]", answer))
    has_valid_citation = bool(citations)
    is_safe = has_valid_citation or mentions_unknown
    if has_hallucinated_marker:
        note = "stripped hallucinated citation"
    elif mentions_unknown:
        note = "admits lack of knowledge (good)"
    elif has_valid_citation:
        note = "has valid citation (good)"
    else:
        note = "no citation and no admission"
    return {
        "safe_not_guess": is_safe,
        "mentions_unknown": mentions_unknown,
        "has_hallucinated_marker": has_hallucinated_marker,
        "has_valid_citation": has_valid_citation,
        "safety_note": note,
    }


def check_layer_behavior(
    layer: str,
    is_acceptable: bool | None,
    test_type: str | None,
    has_citation: bool,
    content_accurate: bool | None,
    safety: dict[str, Any],
    is_failure: bool = False,
) -> dict[str, Any]:
    if layer == "①-bianguon":
        passed = has_citation and content_accurate in (None, True)
        note = "bianguon+citation OK" if has_citation else "bianguon MISSING citation"
    elif layer == "②-lactrinhdo":
        passed = (content_accurate is True) or (content_accurate is None) or safety["mentions_unknown"]
        note = "lactrinhdo: accurate explanation OK" if passed else "lactrinhdo: inaccurate content"
    elif layer == "③-citesai":
        passed = has_citation or safety["mentions_unknown"] or is_failure
        note = "citesai: citation present or safely handled" if passed else "citesai: citation MISSING"
    elif layer == "④-duoankhi-thieukhong":
        if is_acceptable:
            passed = safety["safe_not_guess"]
            if safety["mentions_unknown"]:
                note = "refused appropriately"
            elif safety["has_valid_citation"]:
                note = "answered with citation"
            else:
                note = "safe but no clear signal"
        else:
            passed = safety["mentions_unknown"] or is_failure
            note = "refused (acceptable for broad question)" if passed else "did not refuse (RISKY)"
    elif layer == "⑤-edge-real":
        passed = safety["safe_not_guess"]
        note = "edge: handled safely" if passed else "edge: FAILED to handle safely"
    else:
        passed = False
        note = "unknown layer"
    return {"layer_pass": passed, "layer_note": note}


def error_result(case: dict[str, Any], exc: Exception, elapsed: int) -> dict[str, Any]:
    return {
        "id": case["id"], "layer": case["layer"], "test_type": case.get("test_type"),
        "scenario": case.get("scenario", ""), "question": case["question"],
        "expected_topics": case.get("expected_topics", []),
        "expected_pages": case.get("expected_cite_pages", []),
        "expected_acceptable": case.get("is_acceptable"),
        "answer_preview": f"ERROR: {exc}", "answer_length": 0,
        "retrieve_mode": "error", "retrieved_codes": "", "citations": "",
        "used_web_research": False, "has_citation": False, "citation_count": 0,
        "cite_format_ok": False, "pages_match": False, "content_accurate": False,
        "matched_topics_count": 0, "match_ratio": 0, "safe_not_guess": False,
        "mentions_unknown": False, "is_failure": True, "layer_pass": False,
        "layer_note": f"error: {exc}", "overall_pass": False, "latency_ms": elapsed,
    }


async def evaluate_case(case: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    response = await ask_tutor(case["question"])
    elapsed = round((time.perf_counter() - started) * 1000)
    answer = response.get("answer") or ""
    citations = response.get("citations") or []
    trace = response.get("trace") or {}
    retrieved = [item.get("code", "") for item in trace.get("retrieved", [])]
    is_failure = bool(response.get("isFailure"))
    cite = check_has_citation(answer, citations)
    cite_format = check_cite_format(answer)
    pages = check_expected_pages(citations, retrieved, case.get("expected_cite_pages", []))
    content = check_content_accuracy(answer, case.get("expected_topics", []))
    safety = check_safety(answer, citations)

    if case["layer"] == "②-lactrinhdo" and content["content_accurate"] is True:
        safety["safe_not_guess"] = True
    if (case["layer"] == "③-citesai" and case.get("is_acceptable") is False) or case.get("test_type") == "negative-test":
        if safety["mentions_unknown"] or is_failure:
            safety["safe_not_guess"] = True

    layer = check_layer_behavior(
        case["layer"], case.get("is_acceptable"), case.get("test_type"), cite["has_citation"],
        content["content_accurate"], safety, is_failure,
    )

    if case["layer"] == "②-lactrinhdo" and content["content_accurate"] is True:
        overall = layer["layer_pass"]
    elif case["layer"] == "③-citesai":
        overall = layer["layer_pass"]
    else:
        overall = (
            safety["safe_not_guess"]
            and (cite["has_citation"] or safety["mentions_unknown"] or not case.get("expected_topics"))
            and layer["layer_pass"]
        )
    return {
        "id": case["id"], "layer": case["layer"], "test_type": case.get("test_type"),
        "scenario": case.get("scenario", ""), "question": case["question"],
        "expected_topics": case.get("expected_topics", []),
        "expected_pages": case.get("expected_cite_pages", []),
        "expected_acceptable": case.get("is_acceptable"),
        "answer_preview": answer[:200].replace("\n", " "), "answer_length": len(answer),
        "retrieve_mode": trace.get("retrieveMode", "unknown"),
        "retrieved_codes": "|".join(retrieved[:5]), "citations": "|".join(citations),
        "used_web_research": bool((response.get("researchInfo") or {}).get("used")),
        "has_citation": cite["has_citation"], "citation_count": cite["citation_count"],
        "cite_format_ok": cite_format["cite_format_ok"], "pages_match": pages["pages_match"],
        "content_accurate": content["content_accurate"],
        "matched_topics_count": content["matched_count"], "match_ratio": content["match_ratio"],
        "safe_not_guess": safety["safe_not_guess"], "mentions_unknown": safety["mentions_unknown"],
        "is_failure": response.get("isFailure"), "layer_pass": layer["layer_pass"],
        "layer_note": layer["layer_note"], "overall_pass": overall, "latency_ms": elapsed,
    }


def percent(numerator: int, denominator: int) -> str:
    return f"{numerator / denominator * 100:.1f}" if denominator else "0.0"


def aggregate(results: list[dict[str, Any]], total_elapsed: float) -> dict[str, Any]:
    total = len(results)
    passed = sum(bool(row["overall_pass"]) for row in results)
    with_topics = [row for row in results if row["expected_topics"]]
    content_count = sum(row["content_accurate"] is True for row in with_topics)
    by_layer: dict[str, dict[str, int]] = {}
    by_test_type: dict[str, dict[str, int]] = {}
    for row in results:
        layer = by_layer.setdefault(row["layer"], {"total": 0, "pass": 0, "has_cite": 0, "content_acc": 0, "with_topics": 0, "latency_sum": 0})
        layer["total"] += 1
        layer["pass"] += int(bool(row["overall_pass"]))
        layer["has_cite"] += int(bool(row["has_citation"]))
        if row["content_accurate"] is True:
            layer["content_acc"] += 1
            layer["with_topics"] += 1
        layer["latency_sum"] += row["latency_ms"]
        test_type = row["test_type"] or "(none)"
        test = by_test_type.setdefault(test_type, {"total": 0, "pass": 0, "safe": 0})
        test["total"] += 1
        test["pass"] += int(bool(row["overall_pass"]))
        test["safe"] += int(bool(row["safe_not_guess"]))
    return {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "total_cases": total, "passed": passed, "failed": total - passed,
        "pass_rate": percent(passed, total) + "%",
        "overall_metrics": {
            "citation_rate": percent(sum(bool(r["has_citation"]) for r in results), total) + "%",
            "safe_not_guess_rate": percent(sum(bool(r["safe_not_guess"]) for r in results), total) + "%",
            "cite_format_ok_rate": percent(sum(bool(r["cite_format_ok"]) for r in results), total) + "%",
            "content_accuracy_rate": (percent(content_count, len(with_topics)) + "%") if with_topics else "N/A%",
            "content_accuracy_evaluated": len(with_topics),
        },
        "performance": {
            "avg_latency_ms": f"{sum(r['latency_ms'] for r in results) / total:.0f}" if total else "0",
            "total_time_s": f"{total_elapsed:.1f}",
            "web_research_used": sum(bool(r["used_web_research"]) for r in results),
        },
        "by_layer": {
            name: {
                "total": data["total"], "passed": data["pass"],
                "pass_rate": percent(data["pass"], data["total"]) + "%",
                "citation_rate": percent(data["has_cite"], data["total"]) + "%",
                "content_accuracy_rate": (percent(data["content_acc"], data["with_topics"]) + "%") if data["with_topics"] else "N/A",
                "avg_latency_ms": f"{data['latency_sum'] / data['total']:.0f}",
            }
            for name, data in by_layer.items()
        },
        "by_test_type": by_test_type,
    }


def metric_number(value: str) -> float:
    try:
        return float(value.rstrip("%"))
    except ValueError:
        return float("nan")


def generate_markdown(summary: dict[str, Any], results: list[dict[str, Any]]) -> str:
    layer_names = {
        "①-bianguon": "① Bianguon (Cơ bản nguồn)",
        "②-lactrinhdo": "② Lactrinhdo (Lạc trình/độ)",
        "③-citesai": "③ Citesai (Trích dẫn sai)",
        "④-duoankhi-thieukhong": "④ Đoán khi thiếu/không có",
        "⑤-edge-real": "⑤ Edge cases (Real chatlog)",
    }
    metrics = summary["overall_metrics"]
    perf = summary["performance"]
    md = f"""# VLearn Tutor — Báo cáo Metrics Evaluation

**Thời gian chạy:** {summary['timestamp']}
**Pipeline:** vlearn.rag.ask_tutor (TF-IDF + Qdrant fallback + tool calling + summarization + web research)
**LLM:** {os.getenv('EVAL_MODEL', 'openai/gpt-4o-mini')} (OpenRouter)
**Golden set:** 40 cases phủ 5 lớp chỗ khó theo rubric

---

## 1. Tổng quan (Overall)

| Metric | Value |
|---|---|
| Tổng số case | **{summary['total_cases']}** |
| Passed | **{summary['passed']}** |
| Failed | **{summary['failed']}** |
| **Pass rate** | **{summary['pass_rate']}** |

### Chiều chất lượng

| Chiều | Rate | Ghi chú |
|---|---|---|
| Citation rate | {metrics['citation_rate']} | Tỷ lệ trả lời có citation hợp lệ |
| Safe-not-guess rate | {metrics['safe_not_guess_rate']} | Tỷ lệ không bịa/bùng |
| Cite format OK | {metrics['cite_format_ok_rate']} | Format [Txx-NNN] / [Cxxxx] đúng |
| Content accuracy | {metrics['content_accuracy_rate']} (n={metrics['content_accuracy_evaluated']}) | Khớp ≥50% expected topics |

### Hiệu năng

| Metric | Value |
|---|---|
| Avg latency | {perf['avg_latency_ms']} ms/case |
| Total time | {perf['total_time_s']} s |
| Web research triggered | {perf['web_research_used']} cases |

---

## 2. Breakdown theo lớp (By Layer)

"""
    for layer, data in summary["by_layer"].items():
        md += f"""### {layer_names.get(layer, layer)}

| Metric | Value |
|---|---|
| Cases | {data['total']} |
| Passed | {data['passed']} / {data['total']} |
| **Pass rate** | **{data['pass_rate']}** |
| Citation rate | {data['citation_rate']} |
| Content accuracy | {data['content_accuracy_rate']} |
| Avg latency | {data['avg_latency_ms']} ms |

"""
    md += """---

## 3. Edge cases theo test_type (chỉ layer ⑤)

| Test type | Cases | Passed | Pass rate | Safe rate |
|---|---|---|---|---|
"""
    for test_type, data in summary["by_test_type"].items():
        if test_type != "(none)":
            md += f"| {test_type} | {data['total']} | {data['pass']} | {percent(data['pass'], data['total'])}% | {percent(data['safe'], data['total'])}% |\n"
    failed = [row for row in results if not row["overall_pass"]]
    md += "\n---\n\n## 4. Chi tiết các case FAIL\n\n"
    if not failed:
        md += "✅ **Không có case fail nào.**\n"
    else:
        md += f"Tổng cộng **{len(failed)} case fail**:\n\n| ID | Layer | Question (60c) | Lý do fail |\n|---|---|---|---|\n"
        for row in failed:
            question = row["question"] if len(row["question"]) <= 60 else row["question"][:57] + "..."
            reasons = []
            if not row["has_citation"] and row["layer"] in ("①-bianguon", "③-citesai"):
                reasons.append("missing citation")
            if row["content_accurate"] is False:
                reasons.append(f"content acc {row['match_ratio']}")
            if not row["safe_not_guess"]:
                reasons.append("unsafe (guessing)")
            if row["is_failure"]:
                reasons.append("isFailure=true")
            md += f"| {row['id']} | {row['layer']} | {question.replace('|', chr(92) + '|')} | {'; '.join(reasons) or row['layer_note']} |\n"
    md += "\n---\n\n## 5. Chi tiết từng case\n\n| ID | Layer | Pass | Cite | Content | Safe | Latency (ms) |\n|---|---|---|---|---|---|---|\n"
    for row in results:
        content = "n/a" if row["content_accurate"] is None else ("✓" if row["content_accurate"] else "✗")
        md += f"| {row['id']} | {row['layer']} | {'✓' if row['overall_pass'] else '✗'} | {'✓' if row['has_citation'] else '✗'} | {content} | {'✓' if row['safe_not_guess'] else '✗'} | {row['latency_ms']} |\n"
    bars = [
        ("Citation rate", 70, metrics["citation_rate"]),
        ("Safe-not-guess", 85, metrics["safe_not_guess_rate"]),
        ("Content accuracy", 70, metrics["content_accuracy_rate"]),
        ("Pass rate tổng", 70, summary["pass_rate"]),
    ]
    md += "\n---\n\n## 6. Đánh giá so với Quality Bar\n\nQuality bar theo rubric (R4 · Kiểm thử — 15đ):\n- Citation rate ≥ 70%\n- Safe-not-guess rate ≥ 85%\n- Content accuracy ≥ 70% (với case có expected_topics)\n- Pass rate tổng ≥ 70%\n\n| Bar | Target | Actual | Đạt? |\n|---|---|---|---|\n"
    for name, target, actual in bars:
        md += f"| {name} | ≥{target}% | {actual} | {'✅' if metric_number(actual) >= target else '❌'} |\n"
    recommendations = []
    if metric_number(metrics["citation_rate"]) < 70:
        recommendations.append("- **Tăng citation rate**: Kiểm tra prompt có đủ ép model chèn mã [Txx-NNN] không. Có thể cần giảm `temperature` hoặc tăng cường hướng dẫn.")
    if metric_number(metrics["content_accuracy_rate"]) < 70:
        recommendations.append("- **Cải thiện content accuracy**: Tăng cường retrieval quality (Qdrant vs TF-IDF), mở rộng top-K, hoặc cải thiện chunking.")
    if metric_number(metrics["safe_not_guess_rate"]) < 85:
        recommendations.append("- **Tăng safety**: Model có xu hướng đoán/bịa khi context yếu. Cần siết chặt fail-safe logic.")
    for layer, data in summary["by_layer"].items():
        if metric_number(data["pass_rate"]) < 70:
            recommendations.append(f"- **Layer {layer}**: pass rate chỉ {data['pass_rate']}. Cần xem lại các case fail cụ thể ở mục 4.")
    md += "\n---\n\n## 7. Khuyến nghị cải thiện\n\n"
    md += "\n".join(recommendations) + "\n" if recommendations else "✅ Hệ thống đạt chuẩn quality bar. Có thể tiếp tục tối ưu chi tiết.\n"
    md += f"""
---

## 8. Files sinh ra

- `eval/metrics-run.csv` — {len(results)} dòng, đầy đủ cột cho từng case
- `eval/metrics-summary.json` — Tổng hợp số liệu dạng JSON
- `eval/metrics-report.md` — File báo cáo này

**Cách tái chạy:**

```bash
python codebase/eval_py/metrics_eval.py
python codebase/eval_py/metrics_eval.py --limit 10
python codebase/eval_py/metrics_eval.py --layer ①-bianguon
```
"""
    return md


def write_outputs(results: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    with OUTPUT_CSV.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        for result in results:
            row = {key: result.get(key, "") for key in CSV_FIELDS}
            row["expected_topics"] = ";".join(result["expected_topics"])
            row["expected_pages"] = ";".join(map(str, result["expected_pages"]))
            writer.writerow({key: js_value(value) for key, value in row.items()})
    OUTPUT_JSON.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    OUTPUT_MD.write_text(generate_markdown(summary, results), encoding="utf-8")


async def main() -> None:
    parser = argparse.ArgumentParser(description="VLearn comprehensive metrics evaluator")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--layer", default=None)
    args = parser.parse_args()

    print("=== VLearn Tutor — Comprehensive Metrics Eval ===\n")
    cases = json.loads(GOLDEN_SET.read_text(encoding="utf-8"))
    if args.layer is not None:
        cases = [case for case in cases if case["layer"] == args.layer]
        print(f'→ Filtered to layer "{args.layer}": {len(cases)} cases')
    if args.limit is not None:
        cases = cases[:args.limit]
        print(f"→ Limited to {len(cases)} cases")
    print(f"→ Total cases to evaluate: {len(cases)}\n")

    results = []
    started = time.perf_counter()
    for index, case in enumerate(cases, 1):
        print(f"[{index}/{len(cases)}] {case['id']} ({case['layer']})... ", end="", flush=True)
        case_started = time.perf_counter()
        try:
            result = await evaluate_case(case)
            results.append(result)
            print(f"{'PASS' if result['overall_pass'] else 'FAIL'} ({result['latency_ms']}ms) [cite={str(result['has_citation']).lower()}, safe={str(result['safe_not_guess']).lower()}, layer={str(result['layer_pass']).lower()}]")
        except Exception as exc:
            elapsed = round((time.perf_counter() - case_started) * 1000)
            print(f"ERROR ({elapsed}ms): {exc}", file=sys.stderr)
            results.append(error_result(case, exc, elapsed))
        await asyncio.sleep(0.8)

    total_elapsed = time.perf_counter() - started
    summary = aggregate(results, total_elapsed)
    write_outputs(results, summary)
    print(f"\n→ Done in {total_elapsed:.1f}s\n")
    print(f"→ CSV written to {OUTPUT_CSV}")
    print(f"→ JSON summary written to {OUTPUT_JSON}")
    print(f"→ Markdown report written to {OUTPUT_MD}")
    print("\n=== TỔNG KẾT ===")
    print(f"Total: {summary['total_cases']} | Pass: {summary['passed']} | Fail: {summary['failed']} | Rate: {summary['pass_rate']}")
    metrics = summary["overall_metrics"]
    print(f"Citation rate: {metrics['citation_rate']} | Safe rate: {metrics['safe_not_guess_rate']} | Content accuracy: {metrics['content_accuracy_rate']}")
    print(f"Avg latency: {summary['performance']['avg_latency_ms']}ms | Total: {summary['performance']['total_time_s']}s")
    print("\nTheo layer:")
    for layer, data in summary["by_layer"].items():
        print(f"  {layer}: {data['passed']}/{data['total']} ({data['pass_rate']})")


if __name__ == "__main__":
    asyncio.run(main())
