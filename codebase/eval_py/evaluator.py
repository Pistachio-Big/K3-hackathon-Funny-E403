#!/usr/bin/env python3
"""Golden-set evaluator, ported from eval/evaluator.js."""

import argparse
import asyncio
import csv
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from vlearn.rag import ask_tutor  # noqa: E402

GOLDEN_SET = ROOT / "eval" / "golden-set.json"
OUTPUT = ROOT / "eval" / "run-1.csv"
FIELDS = [
    "id", "layer", "question", "has_citation", "cite_format_ok",
    "content_accurate", "safe_not_guess", "overall_pass",
    "expected_acceptable", "response_preview",
]


def evaluate(response: str, ground_truth: dict[str, Any]) -> dict[str, bool]:
    cites = re.findall(r"\[?trang\s*(\d+)\]?", response, flags=re.IGNORECASE)
    has_citation = bool(cites)
    cite_format_ok = all(1 <= int(number) <= 100 for number in cites)
    expected_topics = ground_truth.get("expected_topics", [])
    response_lower = response.lower()
    if expected_topics:
        matched = [topic for topic in expected_topics if topic.lower() in response_lower]
        content_accurate = len(matched) >= len(expected_topics) * 0.5
    else:
        content_accurate = True
    unknown_phrases = (
        "không tìm thấy", "không có thông tin", "không có trong tài liệu",
        "ngoài phạm vi", "không liên quan", "tôi không biết",
    )
    mentions_unknown = any(phrase in response_lower for phrase in unknown_phrases)
    has_relevant_content = not expected_topics or any(
        topic.lower() in response_lower for topic in expected_topics
    )
    safe_not_guess = mentions_unknown or has_relevant_content
    return {
        "has_citation": has_citation,
        "cite_format_ok": cite_format_ok,
        "content_accurate": content_accurate,
        "safe_not_guess": safe_not_guess,
        "mentions_unknown": mentions_unknown,
        "overall_pass": safe_not_guess and (content_accurate or mentions_unknown),
    }


def js_bool(value: bool) -> str:
    return "true" if value else "false"


async def main() -> None:
    parser = argparse.ArgumentParser(description="VLearn Tutor AI evaluator")
    parser.add_argument("--dry-run", action="store_true", help="Evaluate only the first three cases")
    args = parser.parse_args()

    print("=== VLearn Tutor AI Evaluator ===\n")
    print("→ Load golden set...")
    cases = json.loads(GOLDEN_SET.read_text(encoding="utf-8"))
    if args.dry_run:
        cases = cases[:3]
    print(f"→ Sẽ eval {len(cases)} case qua vlearn.rag.ask_tutor{' [DRY RUN]' if args.dry_run else ''}\n")

    results = []
    for index, case in enumerate(cases, 1):
        print(f"[{index}/{len(cases)}] {case['id']}: {case['question'][:50]}...")
        try:
            tutor_response = await ask_tutor(case["question"])
            response = tutor_response.get("answer") or ""
            checked = evaluate(response, case)
            result = {
                "id": case["id"], "layer": case["layer"],
                "question": case["question"][:60],
                "has_citation": checked["has_citation"],
                "cite_format_ok": checked["cite_format_ok"],
                "content_accurate": checked["content_accurate"],
                "safe_not_guess": checked["safe_not_guess"],
                "overall_pass": checked["overall_pass"],
                "expected_acceptable": case.get("is_acceptable"),
                "response_preview": response[:100],
            }
            results.append(result)
            print(f"   ✓ Pass: {checked['overall_pass']} | Citation: {checked['has_citation']}")
        except Exception as exc:
            print(f"   ✗ Lỗi: {exc}", file=sys.stderr)
            results.append({
                "id": case["id"], "layer": case["layer"],
                "question": case["question"][:60], "has_citation": False,
                "cite_format_ok": False, "content_accurate": False,
                "safe_not_guess": False, "overall_pass": False,
                "expected_acceptable": case.get("is_acceptable"),
                "response_preview": f"ERROR: {str(exc)[:80]}",
            })
        await asyncio.sleep(0.5)

    with OUTPUT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        for result in results:
            writer.writerow({
                key: js_bool(value) if isinstance(value, bool) else value
                for key, value in result.items()
            })

    passed = sum(result["overall_pass"] for result in results)
    total = len(results)
    print("\n=== SUMMARY ===")
    print(f"Total: {total} | Pass: {passed} | Fail: {total - passed}")
    print(f"Pass rate: {passed / total * 100:.1f}%" if total else "Pass rate: 0.0%")
    by_layer: dict[str, dict[str, int]] = {}
    for result in results:
        data = by_layer.setdefault(result["layer"], {"pass": 0, "total": 0})
        data["total"] += 1
        data["pass"] += int(result["overall_pass"])
    print("\nBy Layer:")
    for layer, data in by_layer.items():
        rate = data["pass"] / data["total"] * 100 if data["total"] else 0
        print(f"  {layer}: {data['pass']}/{data['total']} ({rate:.1f}%)")
    print(f"\n→ Results written to {OUTPUT}")


if __name__ == "__main__":
    asyncio.run(main())
